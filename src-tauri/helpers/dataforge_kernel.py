# DataForge kernel helper for Python (ipykernel).
# Installed as the module `_dataforge` in sys.modules; nothing is bound in the
# user's namespace.
def __dataforge_install():
    import importlib.abc
    import importlib.util
    import json
    import os
    import sys
    import types

    mod = types.ModuleType("_dataforge")
    state = {"theme": None, "plot": {"width": 7.0, "height": 5.0, "dpi": 144}}

    def call(fn, args_json, out):
        try:
            args = json.loads(args_json)
            res = {"ok": True, "value": globals_fns[fn](**args)}
        except Exception as e:  # noqa: BLE001
            res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        if out == "":
            # Remote kernels: the host reads the result from stdout.
            sys.stdout.write("\x1eDFJSON" + json.dumps(res, default=str) + "\x1e")
            sys.stdout.flush()
        else:
            with open(out, "w", encoding="utf-8") as f:
                json.dump(res, f, default=str)

    def _kind(v):
        mod_name = type(v).__module__ or ""
        tname = type(v).__name__
        if tname in ("DataFrame", "Series", "ndarray", "LazyFrame", "Table") and (
            mod_name.startswith(("pandas", "numpy", "polars", "pyarrow"))
        ):
            return "data"
        if isinstance(v, (types.FunctionType, types.BuiltinFunctionType, type, types.MethodType)):
            return "function"
        if isinstance(v, (list, tuple, dict, set)):
            return "list"
        return "value"

    def _dims(v):
        shape = getattr(v, "shape", None)
        if isinstance(shape, tuple):
            return [int(s) for s in shape]
        try:
            return len(v)
        except Exception:  # noqa: BLE001
            return 1

    def _size(v):
        try:
            mu = getattr(v, "memory_usage", None)
            if mu is not None and type(v).__name__ == "DataFrame":
                return int(mu(deep=False).sum())
            nb = getattr(v, "nbytes", None)
            if isinstance(nb, int):
                return nb
            es = getattr(v, "estimated_size", None)
            if callable(es):
                return int(es())
            return sys.getsizeof(v)
        except Exception:  # noqa: BLE001
            return None

    def _preview(v):
        tname = type(v).__name__
        if tname == "DataFrame":
            r, c = v.shape
            return f"{r} obs. of {c} variables"
        if callable(v) and not isinstance(v, type):
            import inspect

            try:
                return f"def {getattr(v, '__name__', '')}{inspect.signature(v)}"
            except (TypeError, ValueError):
                return repr(v)[:160]
        if isinstance(v, type):
            return f"class {v.__name__}"
        try:
            s = repr(v)
        except Exception:  # noqa: BLE001
            s = f"<{tname}>"
        s = " ".join(s.split())
        return s[:160] + ("..." if len(s) > 160 else "")

    _skip = {"In", "Out", "exit", "quit", "get_ipython", "open"}

    def env_list():
        from IPython import get_ipython

        ip = get_ipython()
        ns, hidden = ip.user_ns, ip.user_ns_hidden
        out = []
        for name, v in list(ns.items()):
            if name.startswith("_") or name in _skip:
                continue
            if name in hidden and hidden[name] is v:
                continue
            if isinstance(v, types.ModuleType):
                continue
            out.append(
                {
                    "name": name,
                    "type": type(v).__name__,
                    "kind": _kind(v),
                    "dims": _dims(v),
                    "size": _size(v),
                    "preview": _preview(v),
                }
            )
        out.sort(key=lambda d: d["name"].lower())
        return out

    def clear_env():
        from IPython import get_ipython

        get_ipython().run_line_magic("reset", "-f")
        return True

    # --- plots -------------------------------------------------------------
    def _apply_mpl():
        if "matplotlib.pyplot" not in sys.modules:
            return
        import matplotlib as mpl

        p = state["plot"]
        mpl.rcParams["figure.figsize"] = (p["width"], p["height"])
        mpl.rcParams["figure.dpi"] = 96
        mpl.rcParams["savefig.dpi"] = p["dpi"]
        th = state["theme"]
        if th:
            from cycler import cycler

            mpl.rcParams.update(
                {
                    "figure.facecolor": th["bg"],
                    "axes.facecolor": th["bg"],
                    "savefig.facecolor": th["bg"],
                    "text.color": th["fg"],
                    "axes.labelcolor": th["fg"],
                    "axes.titlecolor": th["fg"],
                    "axes.edgecolor": th["grid"],
                    "xtick.color": th["muted"],
                    "ytick.color": th["muted"],
                    "grid.color": th["grid"],
                    "axes.grid": True,
                    "axes.spines.top": False,
                    "axes.spines.right": False,
                    "legend.frameon": False,
                    "axes.prop_cycle": cycler(color=th["palette"]),
                }
            )
        try:
            from matplotlib_inline.backend_inline import set_matplotlib_formats

            set_matplotlib_formats("png", "svg", "pdf")
        except Exception:  # noqa: BLE001
            pass

    class _PyplotHook(importlib.abc.MetaPathFinder):
        """Configures matplotlib right after `import matplotlib.pyplot`."""

        def find_spec(self, fullname, path, target=None):
            if fullname != "matplotlib.pyplot":
                return None
            sys.meta_path.remove(self)
            try:
                spec = importlib.util.find_spec(fullname)
            finally:
                sys.meta_path.insert(0, self)
            if spec is None or spec.loader is None:
                return spec
            loader = spec.loader
            orig_exec = loader.exec_module

            def exec_module(module):
                orig_exec(module)
                _apply_mpl()

            loader.exec_module = exec_module
            return spec

    if not any(type(f).__name__ == "_PyplotHook" for f in sys.meta_path):
        sys.meta_path.insert(0, _PyplotHook())

    def configure(plot=None, theme=None):
        if plot:
            state["plot"] = plot
        if theme:
            state["theme"] = theme
        _apply_mpl()
        return True

    # --- data viewer -------------------------------------------------------
    # Data stays in the kernel; the UI pages through it. Filter/sort results
    # are cached per query so scrolling only slices arrays.
    views = {}
    cache = {}
    view_seq = [0]

    def _user_ns():
        from IPython import get_ipython

        return get_ipython().user_ns

    def _resolve(name):
        return views[name] if name.startswith("@") else _user_ns()[name]

    def _frame(name, rev):
        hit = cache.get(("frame", name))
        if hit and hit[0] == rev:
            return hit[1]
        import pandas as pd

        x = _resolve(name)
        mod_name = type(x).__module__ or ""
        if isinstance(x, pd.DataFrame):
            frame = x
        elif isinstance(x, pd.Series):
            frame = x.to_frame(name=x.name if x.name is not None else "value")
        elif mod_name.startswith("polars") or mod_name.startswith("pyarrow"):
            frame = x.to_pandas()
        elif isinstance(x, dict):
            frame = pd.DataFrame(x)
        else:
            import numpy as np

            arr = np.asarray(x)
            frame = pd.DataFrame(arr if arr.ndim == 2 else arr.reshape(len(arr), -1) if arr.ndim > 2 else {"value": arr})
        cache[("frame", name)] = (rev, frame)
        return frame

    def _col_type(col):
        import pandas as pd

        dt = col.dtype
        if isinstance(dt, pd.CategoricalDtype):
            return "fct", "factor"
        k = dt.kind
        if k == "b":
            return "lgl", "logical"
        if k in "iu":
            return "int", "numeric"
        if k == "f":
            return "dbl", "numeric"
        if k == "c":
            return "cpl", "numeric"
        if k == "M":
            return "dttm", "date"
        if k == "m":
            return "drtn", "date"
        if k in "OUS" or str(dt) == "string":
            return "chr", "text"
        return str(dt), "list"

    def data_info(name, rev=0):
        frame = _frame(name, rev)
        cols = []
        for j in range(frame.shape[1]):
            t, tone = _col_type(frame.iloc[:, j])
            cols.append({"name": str(frame.columns[j]), "type": t, "tone": tone})
        return {"name": name, "rows": int(frame.shape[0]), "cols": int(frame.shape[1]), "columns": cols, "class": type(_resolve(name)).__name__}

    def _fmt(col):
        import math

        k = col.dtype.kind
        na = col.isna().to_numpy()
        vals = col.tolist()
        out = []
        for v, missing in zip(vals, na):
            if missing:
                out.append(None)
            elif k == "f":
                out.append(format(v, ".7g") if math.isfinite(v) else str(v))
            elif isinstance(v, (list, tuple, dict, set)):
                out.append(f"<{type(v).__name__}[{len(v)}]>")
            else:
                out.append(str(v))
        return out

    def _coerce(col, val):
        import pandas as pd

        k = col.dtype.kind
        if k == "M":
            return pd.Timestamp(val)
        if k in "iufb":
            return float(val)
        return val

    def _apply_filter(col, f):
        import numpy as np

        op, val = f["op"], f.get("value")
        if op == "isna":
            return col.isna().to_numpy()
        if op == "notna":
            return col.notna().to_numpy()
        if op == "contains":
            return col.astype(str).str.lower().str.contains(str(val).lower(), regex=False).fillna(False).to_numpy() & col.notna().to_numpy()
        if op == "oneof":
            return col.astype(str).isin([str(v) for v in val]).to_numpy()
        is_text = col.dtype.kind in "OUS" or str(col.dtype) in ("string", "category")
        if is_text and op in ("eq", "neq"):
            r = col.astype(str) == str(val)
            return (r if op == "eq" else ~r).to_numpy() & col.notna().to_numpy()
        try:
            if op == "between":
                r = (col >= _coerce(col, val[0])) & (col <= _coerce(col, val[1]))
            else:
                v = _coerce(col, val)
                r = {"eq": col == v, "neq": col != v, "gt": col > v, "gte": col >= v, "lt": col < v, "lte": col <= v}[op]
            return r.fillna(False).to_numpy(dtype=bool)
        except (TypeError, ValueError, KeyError):
            return np.ones(len(col), dtype=bool)

    def _search_hits(frame, query):
        import numpy as np

        q = query.lower()
        try:
            num = float(query)
        except ValueError:
            num = None
        hits = np.zeros(len(frame), dtype=bool)
        for j in range(frame.shape[1]):
            col = frame.iloc[:, j]
            _, tone = _col_type(col)
            if tone in ("text", "factor"):
                hits |= col.astype(str).str.lower().str.contains(q, regex=False).fillna(False).to_numpy() & col.notna().to_numpy()
            elif num is not None and tone == "numeric":
                hits |= (col == num).fillna(False).to_numpy(dtype=bool)
        return hits

    def _index(frame, name, rev, sort, search, filters):
        import numpy as np

        key = json.dumps([rev, sort, search, filters], sort_keys=True)
        hit = cache.get(("idx", name))
        if hit and hit[0] == key:
            return hit[1]
        mask = np.ones(len(frame), dtype=bool)
        for f in filters:
            mask &= _apply_filter(frame.iloc[:, f["col"]], f)
        if search:
            mask &= _search_hits(frame, search)
        idx = np.flatnonzero(mask)
        if sort:
            sub = frame.iloc[idx, [s["col"] for s in sort]].copy()
            sub.columns = list(range(len(sort)))
            sub = sub.reset_index(drop=True)
            asc = [not s.get("desc") for s in sort]
            try:
                order = sub.sort_values(by=list(sub.columns), ascending=asc, na_position="last", kind="stable").index.to_numpy()
            except TypeError:
                order = sub.astype(str).sort_values(by=list(sub.columns), ascending=asc, kind="stable").index.to_numpy()
            idx = idx[order]
        cache[("idx", name)] = (key, idx)
        return idx

    def data_page(name, rev=0, offset=0, limit=200, sort=(), search="", filters=()):
        frame = _frame(name, rev)
        idx = _index(frame, name, rev, list(sort), search or "", list(filters))
        rows = idx[offset : offset + min(int(limit), 1000)]
        page = frame.iloc[rows]
        cols = [_fmt(page.iloc[:, j]) for j in range(page.shape[1])]
        return {"total": int(len(idx)), "offset": int(offset), "rows": [int(r) + 1 for r in rows], "columns": cols}

    def _stat_one(col, j):
        import numpy as np

        s = {"col": j, "na": int(col.isna().sum())}
        _, tone = _col_type(col)
        if tone in ("numeric", "date") and col.dtype.kind != "c":
            is_time = col.dtype.kind in "Mm"
            arr = col.dropna().to_numpy()
            num = arr.astype("int64").astype(float) if is_time else arr.astype(float)
            num = num[np.isfinite(num)]
            if len(num):
                lo, hi = float(num.min()), float(num.max())
                if lo == hi:
                    counts = [int(len(num))]
                else:
                    counts = np.histogram(num, bins=20, range=(lo, hi))[0].tolist()
                s["hist"] = counts
                if is_time:
                    s["min"], s["max"] = str(arr.min()), str(arr.max())
                else:
                    s["min"], s["max"], s["mean"] = format(lo, ".5g"), format(hi, ".5g"), format(float(num.mean()), ".5g")
        elif tone in ("text", "factor", "logical"):
            vc = col.astype(str).where(col.notna()).value_counts(dropna=True)
            s["unique"] = int(len(vc))
            s["top"] = [{"value": str(k), "count": int(v)} for k, v in vc.head(5).items()]
        return s

    def data_stats(name, rev=0, cols=()):
        frame = _frame(name, rev)
        out = []
        for c in cols:
            hit = cache.get(("stats", name, c))
            if hit and hit[0] == rev:
                out.append(hit[1])
                continue
            s = _stat_one(frame.iloc[:, c], c)
            cache[("stats", name, c)] = (rev, s)
            out.append(s)
        return out

    def data_release(name):
        for k in [k for k in cache if k[1] == name]:
            del cache[k]
        return True

    def view(obj, title=None):
        """Open an object in the DataForge data viewer (like RStudio's View())."""
        from IPython.display import display

        ns = _user_ns()
        name = next((k for k, v in ns.items() if v is obj and not k.startswith("_")), None)
        if name is None:
            view_seq[0] += 1
            name = f"@{view_seq[0]}"
            views[name] = obj
        label = title or name
        display(
            {"application/vnd.dataforge.view+json": json.dumps({"name": name, "title": label}), "text/plain": f"View: {label}"},
            raw=True,
        )

    import builtins

    builtins.View = view

    # --- R <-> Python bridge ---------------------------------------------------
    # "dfc" folders: manifest.json + one little-endian file per column
    # (float64 / int32, NA = NaN / INT_MIN), strings as JSON arrays.
    INT_NA = -(2**31)

    def _bin_write(path, values, kind):
        import numpy as np

        np.ascontiguousarray(values, dtype="<f8" if kind == "double" else "<i4").tofile(path)

    def _bin_read(path, kind, n):
        import numpy as np

        return np.fromfile(path, dtype="<f8" if kind == "double" else "<i4", count=n)

    def _is_missing(x):
        return x is None or type(x).__name__ in ("NAType", "NaTType") or (isinstance(x, float) and x != x)

    NEED_PANDAS = (
        "this value needs pandas and numpy in the Python environment "
        "(install them in the Packages panel, or: pip install pandas)"
    )

    def _have_pandas():
        try:
            import numpy  # noqa: F401
            import pandas  # noqa: F401

            return True
        except ImportError:
            return False

    def _pure_vector_write(values, path):
        """Scalars and plain lists without numpy/pandas."""
        __tracebackhide__ = True  # noqa: F841 (IPython hides this frame)
        import datetime as _dt
        from array import array

        def dump(arr, name):
            if sys.byteorder == "big":
                arr.byteswap()
            with open(os.path.join(path, name), "wb") as f:
                arr.tofile(f)

        present = [v for v in values if not _is_missing(v)]
        kind = _scalar_class(present[0]) if present else "number"
        if kind == "bool":
            dump(array("i", [INT_NA if _is_missing(v) else int(v) for v in values]), "c1")
            col = {"type": "logical", "file": "c1"}
        elif kind == "number":
            if all(isinstance(v, int) and INT_NA < v < 2**31 for v in present):
                dump(array("i", [INT_NA if _is_missing(v) else v for v in values]), "c1")
                col = {"type": "int", "file": "c1"}
            else:
                dump(array("d", [float("nan") if _is_missing(v) else float(v) for v in values]), "c1")
                col = {"type": "double", "file": "c1"}
        elif kind == "time" and all(type(v) is _dt.date for v in present):
            dump(array("d", [float("nan") if _is_missing(v) else v.toordinal() - 719163 for v in values]), "c1")
            col = {"type": "date", "file": "c1"}
        elif kind == "time":
            def secs(v):
                if v.tzinfo is None:
                    v = v.replace(tzinfo=_dt.timezone.utc)
                return v.timestamp()
            dump(array("d", [float("nan") if _is_missing(v) else secs(v) for v in values]), "c1")
            col = {"type": "datetime", "file": "c1", "tz": "UTC"}
        else:
            with open(os.path.join(path, "c1.json"), "w", encoding="utf-8") as f:
                json.dump([None if _is_missing(v) else str(v) for v in values], f, ensure_ascii=False)
            col = {"type": "string", "file": "c1.json"}
        return {"kind": "vector", "n": len(values), "names": None, "columns": [col]}

    def _pure_vector_read(man, path):
        __tracebackhide__ = True  # noqa: F841 (IPython hides this frame)
        import datetime as _dt
        from array import array

        m, n = man["columns"][0], man["n"]
        full = os.path.join(path, m["file"])
        t = m["type"]

        def load(code):
            arr = array(code)
            with open(full, "rb") as f:
                arr.fromfile(f, n)
            if sys.byteorder == "big":
                arr.byteswap()
            return arr

        if t == "string":
            with open(full, encoding="utf-8") as f:
                out = json.load(f)
        elif t == "double":
            out = list(load("d"))
        elif t == "date":
            out = [None if d != d else _dt.date.fromordinal(int(d) + 719163) for d in load("d")]
        elif t == "datetime":
            out = [None if v != v else _dt.datetime.fromtimestamp(v, _dt.timezone.utc) for v in load("d")]
        else:
            raw = [None if v == INT_NA else v for v in load("i")]
            if t == "logical":
                out = [None if v is None else bool(v) for v in raw]
            elif t == "factor":
                levels = m.get("levels") or []
                out = [None if v is None else levels[v - 1] for v in raw]
            else:
                out = raw
        if man.get("names"):
            return dict(zip(man["names"], out))
        return out[0] if n == 1 else out

    def _dfc_write_col(s, path, i):
        """Encode a pandas Series as a dfc column."""
        __tracebackhide__ = True  # noqa: F841 (IPython hides this frame)
        import numpy as np
        import pandas as pd

        file = f"c{i}"
        full = os.path.join(path, file)
        dt = s.dtype
        na = s.isna().to_numpy()
        if isinstance(dt, pd.CategoricalDtype):
            codes = s.cat.codes.to_numpy().astype("int64") + 1
            codes[na] = INT_NA
            _bin_write(full, codes, "int")
            return {"type": "factor", "file": file, "levels": [str(c) for c in s.cat.categories]}
        if pd.api.types.is_datetime64_any_dtype(dt):
            tz = getattr(dt, "tz", None)
            v = s.dt.tz_convert("UTC").dt.tz_localize(None) if tz is not None else s
            secs = v.to_numpy().astype("datetime64[ns]").astype("int64") / 1e9
            secs[na] = np.nan
            _bin_write(full, secs, "double")
            return {"type": "datetime", "file": file, "tz": str(tz) if tz is not None else "UTC"}
        if pd.api.types.is_timedelta64_dtype(dt):
            _bin_write(full, s.dt.total_seconds().to_numpy(dtype="float64"), "double")
            return {"type": "double", "file": file}
        if pd.api.types.is_bool_dtype(dt):
            v = s.fillna(False).astype(bool).to_numpy().astype("int64")
            v[na] = INT_NA
            _bin_write(full, v, "int")
            return {"type": "logical", "file": file}
        if pd.api.types.is_integer_dtype(dt):
            v = s.astype("float64").to_numpy() if na.any() else s.to_numpy()
            ok = v[~na]
            if ok.size == 0 or (ok.min() > INT_NA and ok.max() < 2**31):
                iv = np.where(na, 0, v).astype("int64")
                iv[na] = INT_NA
                _bin_write(full, iv, "int")
                return {"type": "int", "file": file}
            _bin_write(full, v.astype("float64"), "double")
            return {"type": "double", "file": file}
        if pd.api.types.is_float_dtype(dt):
            _bin_write(full, s.astype("float64").to_numpy(), "double")
            return {"type": "double", "file": file}
        vals = [x for x in s.tolist() if not _is_missing(x)]
        if dt == object and vals:
            if all(isinstance(x, bool) for x in vals):
                return _dfc_write_col(s.astype("boolean"), path, i)
            if all(type(x).__name__ == "date" for x in vals):
                days = np.array([np.nan if _is_missing(x) else x.toordinal() - 719163 for x in s.tolist()], dtype="float64")
                _bin_write(full, days, "double")
                return {"type": "date", "file": file}
            if all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in vals):
                return _dfc_write_col(pd.to_numeric(s), path, i)
        out = [None if _is_missing(x) else str(x) for x in s.tolist()]
        with open(full + ".json", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        return {"type": "string", "file": file + ".json"}

    def _dfc_read_col(m, n, path):
        """Decode a dfc column into something pandas.Series() accepts."""
        __tracebackhide__ = True  # noqa: F841 (IPython hides this frame)
        import numpy as np
        import pandas as pd

        full = os.path.join(path, m["file"])
        t = m["type"]
        if t == "double":
            return _bin_read(full, "double", n)
        if t == "string":
            with open(full, encoding="utf-8") as f:
                return np.array(json.load(f), dtype=object)
        if t == "date":
            return pd.to_datetime(_bin_read(full, "double", n), unit="D")
        if t == "datetime":
            out = pd.to_datetime(_bin_read(full, "double", n), unit="s", utc=True)
            tz = m.get("tz") or ""
            if tz == "UTC":
                return out.tz_localize(None)
            if tz == "":  # R's session time zone: keep the local wall-clock time
                import datetime as _dt

                return out.tz_convert(_dt.datetime.now().astimezone().tzinfo).tz_localize(None)
            return out.tz_convert(tz)
        v = _bin_read(full, "int", n)
        na = v == INT_NA
        if t == "factor":
            codes = v.astype("int64") - 1
            codes[na] = -1
            return pd.Categorical.from_codes(codes, categories=m.get("levels") or [])
        if t == "logical":
            if not na.any():
                return v != 0
            arr = pd.array(v != 0, dtype="boolean")
            arr[na] = pd.NA
            return arr
        if t == "int":
            if not na.any():
                return v.astype("int64")
            arr = pd.array(np.where(na, 0, v).astype("int64"), dtype="Int64")
            arr[na] = pd.NA
            return arr
        raise ValueError(f"unknown column type {t}")

    def _plain(v):
        """JSON fallback: numpy/pandas scalars and arrays to plain Python."""
        if hasattr(v, "tolist"):
            return v.tolist()
        if hasattr(v, "isoformat"):
            return v.isoformat()
        raise TypeError(f"cannot transfer an object of type '{type(v).__name__}'")

    def _scalar_class(v):
        import datetime as _dt

        np = sys.modules.get("numpy")
        if isinstance(v, bool) or (np and isinstance(v, np.bool_)):
            return "bool"
        if isinstance(v, (int, float)) or (np and isinstance(v, np.number)):
            return "number"
        if isinstance(v, str):
            return "str"
        if isinstance(v, _dt.date) or (np and isinstance(v, np.datetime64)):
            return "time"
        return None

    def _homogeneous(items):
        """A non-empty list of same-kind scalars (missing values allowed) → vector."""
        kinds = {_scalar_class(e) for e in items if not _is_missing(e)}
        return len(kinds) == 1 and None not in kinds and all(_is_missing(e) or _scalar_class(e) for e in items)

    def dfc_write(x, path):
        __tracebackhide__ = True  # noqa: F841 (IPython hides this frame)
        os.makedirs(path, exist_ok=True)
        if not _have_pandas():
            if x is None:
                man = {"kind": "null"}
            elif _scalar_class(x) or (isinstance(x, (list, tuple)) and _homogeneous(x)):
                man = _pure_vector_write([x] if _scalar_class(x) else list(x), path)
            else:
                try:
                    text = json.dumps(x, default=_plain, ensure_ascii=False)
                except (TypeError, ValueError) as e:
                    raise TypeError(f"cannot transfer an object of type '{type(x).__name__}'") from e
                with open(os.path.join(path, "value.json"), "w", encoding="utf-8") as f:
                    f.write(text)
                man = {"kind": "json", "file": "value.json"}
            man["version"] = 1
            with open(os.path.join(path, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump(man, f, ensure_ascii=False)
            return man["kind"]

        import numpy as np
        import pandas as pd

        if hasattr(x, "to_pandas") and not isinstance(x, (pd.DataFrame, pd.Series)):
            x = x.to_pandas()  # polars, pyarrow
        if x is None:
            man = {"kind": "null"}
        elif _scalar_class(x):
            man = {"kind": "vector", "n": 1, "names": None, "columns": [_dfc_write_col(pd.Series([x]), path, 1)]}
        elif isinstance(x, pd.DataFrame):
            idx = x.index
            plain = isinstance(idx, pd.RangeIndex) and idx.start == 0 and idx.step == 1
            names = ["_".join(map(str, c)) if isinstance(c, tuple) else str(c) for c in x.columns]
            man = {
                "kind": "frame",
                "nrow": len(x),
                "rownames": None if plain else [str(r) for r in idx],
                "columns": [dict(name=nm, **_dfc_write_col(x.iloc[:, j], path, j + 1)) for j, nm in enumerate(names)],
            }
        elif isinstance(x, pd.Series) or (isinstance(x, np.ndarray) and x.ndim == 1):
            s = x if isinstance(x, pd.Series) else pd.Series(x)
            idx = s.index
            plain = isinstance(idx, pd.RangeIndex) and idx.start == 0 and idx.step == 1
            man = {"kind": "vector", "n": len(s), "names": None if plain else [str(r) for r in idx],
                   "columns": [_dfc_write_col(s.reset_index(drop=True), path, 1)]}
        elif isinstance(x, np.ndarray) and x.ndim == 2:
            man = {"kind": "matrix", "dims": list(x.shape),
                   "columns": [_dfc_write_col(pd.Series(x.ravel(order="F")), path, 1)]}
        elif isinstance(x, (list, tuple)) and _homogeneous(x):
            man = {"kind": "vector", "n": len(x), "names": None, "columns": [_dfc_write_col(pd.Series(list(x)), path, 1)]}
        else:
            try:
                text = json.dumps(x, default=_plain, ensure_ascii=False)
            except (TypeError, ValueError) as e:
                raise TypeError(f"cannot transfer an object of type '{type(x).__name__}'") from e
            with open(os.path.join(path, "value.json"), "w", encoding="utf-8") as f:
                f.write(text)
            man = {"kind": "json", "file": "value.json"}
        man["version"] = 1
        with open(os.path.join(path, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(man, f, ensure_ascii=False)
        return man["kind"]

    def dfc_read(path):
        __tracebackhide__ = True  # noqa: F841 (IPython hides this frame)
        with open(os.path.join(path, "manifest.json"), encoding="utf-8") as f:
            man = json.load(f)
        kind = man["kind"]
        if kind == "null":
            return None
        if kind == "json":
            with open(os.path.join(path, man["file"]), encoding="utf-8") as f:
                return json.load(f)
        if not _have_pandas():
            if kind == "vector":
                return _pure_vector_read(man, path)
            raise ImportError(f"{'data frames' if kind == 'frame' else 'matrices'}: {NEED_PANDAS}")

        import numpy as np
        import pandas as pd

        if kind == "frame":
            n = man["nrow"]
            cols = {m["name"]: _dfc_read_col(m, n, path) for m in man["columns"]}
            out = pd.DataFrame(cols, index=man["rownames"] if man.get("rownames") else None)
            if not cols:
                out = pd.DataFrame(index=range(n))
            return out
        if kind == "matrix":
            rows, ncol = man["dims"]
            v = _dfc_read_col(man["columns"][0], rows * ncol, path)
            arr = np.asarray(v).reshape((rows, ncol), order="F")
            if man.get("rownames") or man.get("colnames"):
                return pd.DataFrame(arr, index=man.get("rownames"), columns=man.get("colnames"))
            return arr
        if kind == "vector":
            m = man["columns"][0]
            v = _dfc_read_col(m, man["n"], path)
            if man.get("names"):
                return pd.Series(v, index=man["names"])
            if m["type"] in ("factor", "date", "datetime"):
                return pd.Series(v)
            if man["n"] == 1:
                e = v[0]
                return None if _is_missing(e) else (e.item() if hasattr(e, "item") else e)
            if m["type"] == "string":
                return list(v)
            return v if isinstance(v, np.ndarray) else np.asarray(v, dtype=object)
        raise ValueError(f"unknown value kind {kind}")

    def bridge_export(name, path):
        ns = _user_ns()
        if name not in ns:
            raise NameError(f"name '{name}' is not defined in Python")
        return {"path": path, "kind": dfc_write(ns[name], path)}

    def bridge_import(name, path):
        import shutil

        try:
            _user_ns()[name] = dfc_read(path)
        finally:
            shutil.rmtree(path, ignore_errors=True)
        return True

    def bridge_names():
        return [d["name"] for d in env_list()]

    def _bridge_request(endpoint, params, timeout=None):
        __tracebackhide__ = True  # noqa: F841 (IPython hides this frame)
        import urllib.parse
        import urllib.request

        base = os.environ.get("DATAFORGE_BRIDGE_URL")
        if not base:
            raise RuntimeError("the R/Python bridge is only available inside DataForge")
        q = urllib.parse.urlencode({**params, "token": os.environ.get("DATAFORGE_BRIDGE_TOKEN", "")})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"{base}{endpoint}?{q}", timeout=timeout) as resp:
            res = json.loads(resp.read().decode("utf-8"))
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "bridge error")
        return res["value"]

    def bridge_pull(lang, name):
        __tracebackhide__ = True  # noqa: F841 (IPython hides this frame)
        import shutil

        res = _bridge_request("/pull", {"lang": lang, "name": name})
        try:
            return dfc_read(res["path"])
        finally:
            shutil.rmtree(res["path"], ignore_errors=True)

    def bridge_push(lang, name, value):
        __tracebackhide__ = True  # noqa: F841 (IPython hides this frame)
        import shutil
        import uuid

        path = os.path.join(os.environ.get("DATAFORGE_BRIDGE_DIR", ""), "p" + uuid.uuid4().hex)
        try:
            dfc_write(value, path)
            _bridge_request("/push", {"lang": lang, "name": name, "path": path})
        except BaseException:
            shutil.rmtree(path, ignore_errors=True)
            raise

    class RBridge:
        """`r`: the R kernel's variables. `r.x` reads, `r.x = value` writes."""

        __slots__ = ()

        def __getattr__(self, name):
            __tracebackhide__ = True  # noqa: F841
            if name.startswith("__"):
                raise AttributeError(name)
            return bridge_pull("r", name)

        def __setattr__(self, name, value):
            __tracebackhide__ = True  # noqa: F841
            bridge_push("r", name, value)

        __getitem__ = __getattr__
        __setitem__ = __setattr__

        def __dir__(self):
            try:
                return _bridge_request("/names", {"lang": "r"}, timeout=3)
            except Exception:  # noqa: BLE001
                return []

        def __repr__(self):
            return "<R bridge>  r.name reads an R variable, r.name = value writes one"

    builtins.r = RBridge()

    def debugfile(path):
        """Run a script under the debugger: compiled with its real path, so
        editor breakpoints (debugpy) apply, in the console's namespace."""
        path = os.path.abspath(path)
        with open(path, encoding="utf-8") as f:
            code = compile(f.read(), path, "exec")
        exec(code, _user_ns())

    builtins.debugfile = debugfile

    # --- packages ------------------------------------------------------------
    def packages():
        import importlib.metadata as md

        try:
            mapping = md.packages_distributions()
        except Exception:  # noqa: BLE001
            mapping = {}
        modules_of = {}
        for mod, dists in mapping.items():
            for d in dists:
                modules_of.setdefault(d.lower(), []).append(mod)
        loaded_top = {m.split(".")[0] for m in list(sys.modules)}
        out, seen = [], set()
        for d in md.distributions():
            name = d.metadata.get("Name")
            if not name or name.lower() in seen:
                continue
            seen.add(name.lower())
            mods = sorted(set(modules_of.get(name.lower(), [])), key=lambda m: (m.startswith("_"), len(m)))
            out.append(
                {
                    "name": name,
                    "version": d.version,
                    "title": d.metadata.get("Summary") or None,
                    "lib": str(getattr(d, "_path", "") and os.path.dirname(str(d._path))),
                    "modules": mods[:5],
                    "loaded": any(m in loaded_top for m in mods),
                    "attached": any(m in loaded_top for m in mods),
                    "base": False,
                }
            )
        out.sort(key=lambda p: p["name"].lower())
        return out

    def packages_outdated():
        import subprocess

        r = subprocess.run(
            [sys.executable, "-m", "pip", "list", "--outdated", "--format", "json", "--disable-pip-version-check"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "pip failed")
        return [{"name": p["name"], "latest": p["latest_version"]} for p in json.loads(r.stdout or "[]")]

    def lib_info():
        import site

        return {
            "libPaths": [p for p in sys.path if p.endswith("site-packages")] or site.getsitepackages(),
            "prefix": sys.prefix,
            "venv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),
            "hasPip": importlib.util.find_spec("pip") is not None,
            "executable": sys.executable,
        }

    # --- help ----------------------------------------------------------------
    import re as _re

    _NAME = _re.compile(r"^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$")

    def _locate(topic):
        import pydoc

        if not _NAME.match(topic):
            return None
        parts = topic.split(".")
        ns = _user_ns()
        import builtins as _b

        if parts[0] in ns:
            obj = ns[parts[0]]
        elif hasattr(_b, parts[0]):
            obj = getattr(_b, parts[0])
        else:
            return pydoc.locate(topic)
        for p in parts[1:]:
            obj = getattr(obj, p, None)
            if obj is None:
                return None
        return obj

    def help_doc(topic):
        import inspect

        obj = _locate(topic.strip())
        if obj is None:
            return {"found": False, "topic": topic}
        try:
            sig = str(inspect.signature(obj))
        except (TypeError, ValueError):
            sig = None
        members = []
        if inspect.ismodule(obj) or inspect.isclass(obj):
            for name, val in inspect.getmembers(obj):
                if name.startswith("_"):
                    continue
                doc = inspect.getdoc(val) or ""
                members.append({"name": name, "kind": type(val).__name__, "summary": doc.strip().split("\n")[0][:160]})
                if len(members) >= 300:
                    break
        mod = getattr(obj, "__module__", None) or (obj.__name__ if inspect.ismodule(obj) else None)
        return {
            "found": True,
            "topic": topic,
            "name": getattr(obj, "__qualname__", None) or getattr(obj, "__name__", topic),
            "module": mod,
            "kind": "module" if inspect.ismodule(obj) else "class" if inspect.isclass(obj) else "function" if callable(obj) else type(obj).__name__,
            "signature": sig,
            "doc": inspect.getdoc(obj) or "",
            "members": members,
        }

    def help_search(query):
        q = query.lower()
        out, seen = [], set()

        def add(topic, kind):
            if topic not in seen and q in topic.lower():
                seen.add(topic)
                out.append({"topic": topic, "package": kind, "title": ""})

        for name in sorted(_user_ns()):
            if not name.startswith("_"):
                add(name, "workspace")
        import builtins as _b

        for name in dir(_b):
            if not name.startswith("_"):
                add(name, "builtins")
        for mod_name, mod in sorted(sys.modules.items()):
            if mod_name.startswith("_") or "." in mod_name or mod is None:
                continue
            add(mod_name, "module")
            for attr in getattr(mod, "__all__", [])[:400] if isinstance(getattr(mod, "__all__", None), (list, tuple)) else []:
                add(f"{mod_name}.{attr}", mod_name)
            if len(out) > 80:
                break
        return out[:60]

    # --- reproducibility --------------------------------------------------------

    def repro_info(modules=()):
        """Installed distributions behind the imported modules, with their
        dependency closure (environment markers evaluated), plus a full freeze."""
        import importlib.metadata as md
        import platform
        import re as _re

        try:
            from packaging.requirements import Requirement
        except ImportError:  # pragma: no cover - packaging ships with pip
            Requirement = None
        canon = lambda n: _re.sub(r"[-_.]+", "-", n).lower()
        std = set(getattr(sys, "stdlib_module_names", ())) | set(sys.builtin_module_names)
        mod2dist = md.packages_distributions()
        direct, missing, stdlib_used = {}, [], []
        for m in sorted({m.split(".")[0] for m in modules}):
            if m in std:
                stdlib_used.append(m)
                continue
            dists = mod2dist.get(m)
            if not dists:
                missing.append(m)
                continue
            for d in dists:
                direct.setdefault(canon(d), m)
        closure = {}

        def add(name):
            key = canon(name)
            if key in closure:
                return
            try:
                dist = md.distribution(name)
            except md.PackageNotFoundError:
                return
            closure[key] = {"name": dist.metadata["Name"], "version": dist.version, "direct": key in direct, "module": direct.get(key)}
            for req in dist.requires or []:
                if Requirement is not None:
                    try:
                        r = Requirement(req)
                    except Exception:  # noqa: BLE001
                        continue
                    if r.marker is not None and not r.marker.evaluate({"extra": ""}):
                        continue
                    add(r.name)
                elif "extra ==" not in req:
                    mm = _re.match(r"[A-Za-z0-9_.\-]+", req)
                    if mm:
                        add(mm.group(0))

        for d in direct:
            add(d)
        freeze = sorted({(d.metadata["Name"], d.version) for d in md.distributions() if d.metadata["Name"]}, key=lambda x: x[0].lower())
        return {
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
            "platform": platform.platform(),
            "executable": sys.executable,
            "packages": sorted(closure.values(), key=lambda p: p["name"].lower()),
            "missing": missing,
            "stdlib": stdlib_used,
            "freeze": [f"{n}=={v}" for n, v in freeze],
        }

    def ext_eval(code):
        """Run code for an extension in the console namespace; return what it printed."""
        import ast
        import contextlib
        import io

        tree = ast.parse(code, mode="exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        ns = _user_ns()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            exec(compile(tree, "<extension>", "exec"), ns)
            if last is not None:
                v = eval(compile(last, "<extension>", "eval"), ns)
                if v is not None:
                    print(v.to_string() if hasattr(v, "to_string") else repr(v))
        return buf.getvalue()[:500000]

    def info():
        return {"version": sys.version.split()[0], "cwd": os.getcwd()}

    def setwd(path):
        os.chdir(path)
        return os.getcwd()

    globals_fns = {
        "env_list": env_list,
        "clear_env": clear_env,
        "configure": configure,
        "info": info,
        "setwd": setwd,
        "data_info": data_info,
        "data_page": data_page,
        "data_stats": data_stats,
        "data_release": data_release,
        "packages": packages,
        "packages_outdated": packages_outdated,
        "lib_info": lib_info,
        "help_doc": help_doc,
        "help_search": help_search,
        "bridge_export": bridge_export,
        "bridge_import": bridge_import,
        "bridge_names": bridge_names,
        "repro_info": repro_info,
        "ext_eval": ext_eval,
        "dfc_write": dfc_write,
        "dfc_read": dfc_read,
    }
    mod.call = call
    mod.view = view
    mod.__dict__.update(globals_fns)
    sys.modules["_dataforge"] = mod


__dataforge_install()
del __dataforge_install
