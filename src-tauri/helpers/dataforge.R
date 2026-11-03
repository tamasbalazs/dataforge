# DataForge kernel helper for R (IRkernel).
# Lives in an attached environment ("dataforge:tools") so it never shows up
# in the user's global environment.
local({
  df <- new.env()

  df$call <- function(fn, args_json, out) {
    res <- tryCatch({
      args <- jsonlite::fromJSON(args_json, simplifyVector = FALSE)
      list(ok = TRUE, value = do.call(df[[fn]], args))
    }, error = function(e) list(ok = FALSE, error = conditionMessage(e)))
    if (identical(out, "")) {
      # Remote kernels: the host reads the result from stdout.
      cat("\036DFJSON", jsonlite::toJSON(res, auto_unbox = TRUE, null = "null", na = "null",
                                          digits = NA, force = TRUE), "\036", sep = "")
    } else {
      jsonlite::write_json(res, out, auto_unbox = TRUE, null = "null", na = "null",
                           digits = NA, force = TRUE)
    }
    invisible(NULL)
  }

  df$kind <- function(x) {
    if (is.data.frame(x)) "data"
    else if (is.matrix(x) || is.array(x)) "data"
    else if (is.function(x)) "function"
    else if (is.environment(x)) "environment"
    else if (is.list(x)) "list"
    else "value"
  }

  df$preview <- function(x) {
    if (is.data.frame(x)) return(sprintf("%d obs. of %d variables", nrow(x), ncol(x)))
    if (is.function(x)) return(paste(trimws(utils::head(deparse(args(x)), -1)), collapse = " "))
    if (is.environment(x)) return(format(x))
    if (is.factor(x)) {
      return(sprintf("Factor w/ %d levels: %s", nlevels(x),
                     paste(utils::head(levels(x), 5), collapse = ", ")))
    }
    if (is.atomic(x)) {
      v <- utils::head(x, 10)
      s <- paste(if (is.character(v)) paste0('"', v, '"') else format(v, digits = 4), collapse = " ")
      if (length(x) > 10) s <- paste(s, "...")
      return(substr(s, 1, 160))
    }
    if (is.list(x)) return(sprintf("List of %d", length(x)))
    substr(paste(format(x), collapse = " "), 1, 160)
  }

  df$describe <- function(name, x) {
    d <- dim(x)
    list(
      name = name,
      type = class(x)[1],
      kind = df$kind(x),
      dims = if (!is.null(d)) as.numeric(d) else length(x),
      size = tryCatch(as.numeric(utils::object.size(x)), error = function(e) NA),
      preview = tryCatch(df$preview(x), error = function(e) "")
    )
  }

  df$env_list <- function() {
    e <- globalenv()
    names <- Filter(function(n) !inherits(get(n, envir = e), "dataforge_bridge"), ls(e))
    lapply(names, function(n) df$describe(n, get(n, envir = e)))
  }

  df$clear_env <- function() {
    rm(list = ls(globalenv()), envir = globalenv())
    TRUE
  }

  # --- plots ---------------------------------------------------------------
  df$theme <- NULL

  df$apply_theme <- function() {
    th <- df$theme
    if (is.null(th)) return(invisible())
    options(repr.plot.bg = th$bg)
    grDevices::palette(unlist(th$palette))
    setHook("before.plot.new", NULL, "replace")
    setHook("before.plot.new", function() {
      graphics::par(fg = th$fg, col.axis = th$muted, col.lab = th$fg,
                    col.main = th$fg, col.sub = th$muted)
    })
    if (requireNamespace("ggplot2", quietly = TRUE)) {
      g <- asNamespace("ggplot2")
      base <- g$theme_minimal(base_size = 12)
      t <- base + g$theme(
        plot.background = g$element_rect(fill = th$bg, colour = NA),
        panel.background = g$element_rect(fill = th$bg, colour = NA),
        text = g$element_text(colour = th$fg),
        axis.text = g$element_text(colour = th$muted),
        panel.grid = g$element_line(colour = th$grid),
        legend.key = g$element_rect(fill = th$bg, colour = NA),
        strip.text = g$element_text(colour = th$fg)
      )
      g$theme_set(t)
      options(ggplot2.discrete.colour = unlist(th$palette),
              ggplot2.discrete.fill = unlist(th$palette))
    }
    invisible()
  }

  df$configure <- function(plot = NULL, theme = NULL) {
    if (!is.null(plot)) {
      options(repr.plot.width = plot$width, repr.plot.height = plot$height,
              repr.plot.res = plot$dpi)
    }
    if (!is.null(theme)) {
      df$theme <- theme
      df$apply_theme()
    }
    TRUE
  }

  # --- data viewer -----------------------------------------------------------
  # Data stays in R: the UI asks for one page at a time. Filtering and sorting
  # run here and the resulting row index is cached per query, so scrolling
  # through millions of rows only slices vectors.
  df$views <- new.env()
  df$cache <- new.env()
  df$view_seq <- 0L
  `%||%` <- function(a, b) if (is.null(a)) b else a

  df$resolve <- function(name) {
    if (startsWith(name, "@")) get(name, envir = df$views) else get(name, envir = globalenv())
  }

  df$frame <- function(name, rev) {
    hit <- df$cache[[paste0("frame:", name)]]
    if (!is.null(hit) && identical(hit$rev, rev)) return(hit$frame)
    x <- df$resolve(name)
    frame <- if (is.data.frame(x)) x
      else if (is.matrix(x) || is.array(x)) as.data.frame(x, stringsAsFactors = FALSE)
      else if (is.atomic(x)) data.frame(value = x, stringsAsFactors = FALSE)
      else as.data.frame(x, stringsAsFactors = FALSE)
    assign(paste0("frame:", name), list(rev = rev, frame = frame), envir = df$cache)
    frame
  }

  df$tone <- function(v) {
    if (is.factor(v)) "factor"
    else if (inherits(v, c("Date", "POSIXt", "difftime"))) "date"
    else if (is.logical(v)) "logical"
    else if (is.numeric(v) || is.complex(v)) "numeric"
    else if (is.character(v)) "text"
    else "list"
  }

  df$type_label <- function(v) {
    if (is.factor(v)) "fct"
    else if (inherits(v, "POSIXt")) "dttm"
    else if (inherits(v, "Date")) "date"
    else if (inherits(v, "difftime")) "drtn"
    else if (is.integer(v)) "int"
    else if (is.double(v)) "dbl"
    else if (is.complex(v)) "cpl"
    else if (is.character(v)) "chr"
    else if (is.logical(v)) "lgl"
    else if (is.list(v)) "list"
    else class(v)[1]
  }

  df$data_info <- function(name, rev = 0) {
    x <- df$frame(name, rev)
    cols <- lapply(seq_along(x), function(j) {
      v <- .subset2(x, j)
      list(name = names(x)[j] %||% paste0("V", j), type = df$type_label(v), tone = df$tone(v))
    })
    list(name = name, rows = nrow(x), cols = length(x), columns = cols,
         class = class(df$resolve(name))[1])
  }

  df$fmt <- function(v) {
    na <- if (is.list(v)) vapply(v, function(e) length(e) == 1 && is.na(e), logical(1)) else is.na(v)
    out <- if (is.factor(v)) as.character(v)
      else if (is.double(v) && !inherits(v, c("Date", "POSIXt", "difftime"))) format(v, digits = 7, trim = TRUE)
      else if (is.list(v)) vapply(v, function(e) sprintf("<%s[%d]>", class(e)[1], length(e)), "")
      else if (inherits(v, c("POSIXt", "Date"))) format(v)
      else as.character(v)
    out[na] <- NA_character_
    out
  }

  df$coerce <- function(v, val) {
    if (inherits(v, "Date")) as.Date(val)
    else if (inherits(v, "POSIXt")) as.POSIXct(val)
    else if (is.numeric(v)) as.numeric(val)
    else as.character(val)
  }

  df$apply_filter <- function(v, f) {
    op <- f$op
    if (op == "isna") return(is.na(v))
    if (op == "notna") return(!is.na(v))
    if (is.factor(v)) v <- as.character(v)
    val <- f$value
    r <- switch(op,
      contains = grepl(tolower(val), tolower(as.character(v)), fixed = TRUE),
      eq = if (is.character(v)) v == val else v == df$coerce(v, val),
      neq = if (is.character(v)) v != val else v != df$coerce(v, val),
      gt = v > df$coerce(v, val),
      gte = v >= df$coerce(v, val),
      lt = v < df$coerce(v, val),
      lte = v <= df$coerce(v, val),
      between = v >= df$coerce(v, val[[1]]) & v <= df$coerce(v, val[[2]]),
      oneof = as.character(v) %in% unlist(val),
      rep(TRUE, length(v)))
    r %in% TRUE
  }

  df$search_hits <- function(x, query) {
    n <- nrow(x)
    q <- tolower(query)
    num <- suppressWarnings(as.numeric(query))
    hit <- rep(FALSE, n)
    for (j in seq_along(x)) {
      v <- .subset2(x, j)
      if (is.factor(v)) {
        lv <- grepl(q, tolower(levels(v)), fixed = TRUE)
        hit <- hit | (lv[as.integer(v)] %in% TRUE)
      } else if (is.character(v)) {
        hit <- hit | grepl(q, tolower(v), fixed = TRUE)
      } else if (!is.na(num) && is.numeric(v)) {
        hit <- hit | (v == num) %in% TRUE
      }
    }
    hit
  }

  df$index <- function(x, name, rev, sort, search, filters) {
    key <- as.character(jsonlite::toJSON(list(rev, sort, search, filters), auto_unbox = TRUE))
    hit <- df$cache[[paste0("idx:", name)]]
    if (!is.null(hit) && identical(hit$key, key)) return(hit$idx)
    n <- nrow(x)
    keep <- rep(TRUE, n)
    for (f in filters) keep <- keep & df$apply_filter(.subset2(x, f$col + 1), f)
    if (nzchar(search)) keep <- keep & df$search_hits(x, search)
    idx <- which(keep)
    if (length(sort)) {
      keys <- lapply(sort, function(s) {
        v <- .subset2(x, s$col + 1)[idx]
        if (is.factor(v)) as.integer(v) else if (is.list(v)) lengths(v) else if (is.complex(v)) Mod(v) else v
      })
      dec <- vapply(sort, function(s) isTRUE(s$desc), logical(1))
      o <- tryCatch(
        do.call(order, c(keys, list(decreasing = dec, method = "radix", na.last = TRUE))),
        error = function(e) do.call(order, c(lapply(keys, xtfrm), list(decreasing = dec[1], na.last = TRUE)))
      )
      idx <- idx[o]
    }
    assign(paste0("idx:", name), list(key = key, idx = idx), envir = df$cache)
    idx
  }

  df$data_page <- function(name, rev = 0, offset = 0, limit = 200, sort = list(), search = "", filters = list()) {
    x <- df$frame(name, rev)
    idx <- df$index(x, name, rev, sort, search %||% "", filters)
    limit <- min(limit, 1000)
    from <- offset + 1
    to <- min(offset + limit, length(idx))
    rows <- if (from <= to) idx[from:to] else integer()
    cols <- lapply(seq_along(x), function(j) I(df$fmt(.subset2(x, j)[rows])))
    list(total = length(idx), offset = offset, rows = I(rows), columns = cols)
  }

  df$stat_one <- function(v, j) {
    s <- list(col = j - 1, na = sum(is.na(v)))
    if (inherits(v, c("Date", "POSIXt")) || (is.numeric(v) && !is.complex(v))) {
      num <- as.numeric(v)
      fin <- num[is.finite(num)]
      if (length(fin)) {
        r <- range(fin)
        edges <- if (r[1] == r[2]) c(r[1], r[2]) else seq(r[1], r[2], length.out = 21)
        bins <- length(edges) - 1
        counts <- if (bins == 1) length(fin) else tabulate(pmin(findInterval(fin, edges, rightmost.closed = TRUE), bins), bins)
        s$hist <- I(counts)
        fmt1 <- function(z) if (inherits(v, "Date")) format(as.Date(z, origin = "1970-01-01"))
          else if (inherits(v, "POSIXt")) format(as.POSIXct(z, origin = "1970-01-01"))
          else format(z, digits = 5)
        s$min <- fmt1(r[1]); s$max <- fmt1(r[2])
        if (!inherits(v, c("Date", "POSIXt"))) s$mean <- format(mean(fin), digits = 5)
      }
    } else if (is.factor(v) || is.character(v) || is.logical(v)) {
      tab <- if (is.factor(v)) table(v) else table(v, useNA = "no")
      tab <- sort(tab, decreasing = TRUE)
      s$unique <- length(tab)
      top <- utils::head(tab, 5)
      s$top <- lapply(seq_along(top), function(i) list(value = names(top)[i], count = as.numeric(top[[i]])))
    }
    s
  }

  df$data_stats <- function(name, rev = 0, cols = list()) {
    x <- df$frame(name, rev)
    lapply(unlist(cols), function(c0) {
      key <- paste0("stats:", name, ":", c0)
      hit <- df$cache[[key]]
      if (!is.null(hit) && identical(hit$rev, rev)) return(hit$s)
      s <- df$stat_one(.subset2(x, c0 + 1), c0 + 1)
      assign(key, list(rev = rev, s = s), envir = df$cache)
      s
    })
  }

  df$data_release <- function(name) {
    keys <- ls(df$cache)
    drop <- keys %in% paste0(c("frame:", "idx:"), name) | startsWith(keys, paste0("stats:", name, ":"))
    rm(list = keys[drop], envir = df$cache)
    TRUE
  }

  # View(): opens the DataForge data viewer (masks utils::View like RStudio).
  df$View <- function(x, title) {
    expr <- substitute(x)
    label <- if (missing(title)) paste(deparse(expr), collapse = " ") else title
    name <- if (is.name(expr) && exists(as.character(expr), envir = globalenv(), inherits = FALSE)) {
      as.character(expr)
    } else {
      df$view_seq <- df$view_seq + 1L
      id <- paste0("@", df$view_seq)
      assign(id, x, envir = df$views)
      id
    }
    payload <- as.character(jsonlite::toJSON(list(name = name, title = label), auto_unbox = TRUE))
    IRdisplay::publish_mimebundle(list(`application/vnd.dataforge.view+json` = payload,
                                       `text/plain` = paste("View:", label)))
    invisible(x)
  }

  # --- R <-> Python bridge -------------------------------------------------------
  # Values travel as "dfc" folders: manifest.json + one little-endian file per
  # column (float64 / int32, NA = NaN / INT_MIN), strings as JSON arrays.
  df$dfc_write_col <- function(v, path, i) {
    file <- sprintf("c%d", i)
    bin <- function(x, what) writeBin(x, file.path(path, file), size = if (what == "double") 8L else 4L, endian = "little")
    if (is.factor(v)) {
      bin(as.integer(unclass(v)), "int")
      return(list(type = "factor", file = file, levels = I(as.character(levels(v)))))
    }
    if (inherits(v, "Date")) { bin(as.double(unclass(v)), "double"); return(list(type = "date", file = file)) }
    if (inherits(v, "POSIXct")) {
      tz <- attr(v, "tzone"); tz <- if (is.null(tz)) "" else tz[1]
      bin(as.double(unclass(v)), "double")
      return(list(type = "datetime", file = file, tz = tz))
    }
    if (inherits(v, "difftime")) v <- as.double(v, units = "secs")
    if (is.logical(v)) { bin(as.integer(v), "int"); return(list(type = "logical", file = file)) }
    if (is.integer(v) && is.null(attr(v, "class"))) { bin(v, "int"); return(list(type = "int", file = file)) }
    if (is.numeric(v) && !is.object(v)) { bin(as.double(v), "double"); return(list(type = "double", file = file)) }
    if (!is.character(v)) v <- if (is.list(v)) vapply(v, function(e) paste(format(e), collapse = ", "), "") else as.character(v)
    writeLines(as.character(jsonlite::toJSON(enc2utf8(v), na = "null")), file.path(path, paste0(file, ".json")), useBytes = TRUE)
    list(type = "string", file = paste0(file, ".json"))
  }

  df$dfc_read_col <- function(m, n, path) {
    f <- file.path(path, m$file)
    rd <- function(what) {
      v <- readBin(f, what, n = n, size = if (what == "double") 8L else 4L, endian = "little")
      if (what == "double") v[is.nan(v)] <- NA  # pandas' missing value is NaN
      v
    }
    switch(m$type,
      double = rd("double"),
      int = rd("integer"),
      logical = as.logical(rd("integer")),
      factor = structure(rd("integer"), levels = as.character(unlist(m$levels)), class = "factor"),
      date = structure(rd("double"), class = "Date"),
      datetime = as.POSIXct(rd("double"), origin = "1970-01-01", tz = if (is.null(m$tz)) "UTC" else m$tz),
      string = {
        v <- jsonlite::fromJSON(f, simplifyVector = TRUE)
        if (length(v) == 0) character() else { v <- as.character(v); Encoding(v) <- "UTF-8"; v }
      },
      stop("unknown column type ", m$type))
  }

  df$dfc_write <- function(x, path) {
    dir.create(path, recursive = TRUE, showWarnings = FALSE)
    man <- if (is.data.frame(x)) {
      rn <- if (.row_names_info(x) > 0) I(rownames(x)) else NULL
      list(kind = "frame", nrow = nrow(x), rownames = rn,
           columns = lapply(seq_along(x), function(j)
             c(list(name = names(x)[j]), df$dfc_write_col(.subset2(x, j), path, j))))
    } else if (is.null(x)) {
      list(kind = "null")
    } else if (is.atomic(x) && is.matrix(x)) {
      dn <- dimnames(x)
      list(kind = "matrix", dims = I(dim(x)), rownames = if (!is.null(dn[[1]])) I(dn[[1]]),
           colnames = if (!is.null(dn[[2]])) I(dn[[2]]), columns = list(df$dfc_write_col(as.vector(x), path, 1)))
    } else if (is.atomic(x) && is.null(dim(x)) || is.factor(x)) {
      list(kind = "vector", n = length(x), names = if (!is.null(names(x))) I(names(x)),
           columns = list(df$dfc_write_col(x, path, 1)))
    } else if (is.function(x) || is.environment(x)) {
      stop(sprintf("cannot transfer an object of class '%s'", class(x)[1]))
    } else {
      json <- tryCatch(jsonlite::toJSON(x, auto_unbox = TRUE, null = "null", na = "null", digits = NA, force = FALSE),
                       error = function(e) stop(sprintf("cannot transfer an object of class '%s'", class(x)[1])))
      writeLines(enc2utf8(as.character(json)), file.path(path, "value.json"), useBytes = TRUE)
      list(kind = "json", file = "value.json")
    }
    man$version <- 1
    jsonlite::write_json(man, file.path(path, "manifest.json"), auto_unbox = TRUE, null = "null", digits = NA)
    man$kind
  }

  df$dfc_read <- function(path) {
    man <- jsonlite::fromJSON(file.path(path, "manifest.json"), simplifyVector = FALSE)
    strs <- function(v) if (is.null(v)) NULL else vapply(v, function(e) if (is.null(e)) NA_character_ else as.character(e), "")
    switch(man$kind,
      null = NULL,
      json = jsonlite::fromJSON(file.path(path, man$file), simplifyVector = TRUE,
                                simplifyDataFrame = FALSE, simplifyMatrix = FALSE),
      vector = {
        v <- df$dfc_read_col(man$columns[[1]], man$n, path)
        if (!is.null(man$names)) names(v) <- strs(man$names)
        v
      },
      matrix = {
        d <- as.integer(unlist(man$dims))
        v <- df$dfc_read_col(man$columns[[1]], prod(d), path)
        dim(v) <- d
        if (!is.null(man$rownames) || !is.null(man$colnames)) dimnames(v) <- list(strs(man$rownames), strs(man$colnames))
        v
      },
      frame = {
        n <- man$nrow
        cols <- lapply(man$columns, df$dfc_read_col, n = n, path = path)
        names(cols) <- vapply(man$columns, function(m) as.character(m$name), "")
        out <- structure(cols, row.names = c(NA_integer_, -as.integer(n)), class = "data.frame")
        if (!is.null(man$rownames)) attr(out, "row.names") <- strs(man$rownames)
        out
      },
      stop("unknown value kind ", man$kind))
  }

  df$bridge_export <- function(name, path) {
    x <- get(name, envir = globalenv())
    kind <- df$dfc_write(x, path)
    list(path = path, kind = kind)
  }

  df$bridge_import <- function(name, path) {
    on.exit(unlink(path, recursive = TRUE))
    assign(name, df$dfc_read(path), envir = globalenv())
    TRUE
  }

  df$bridge_names <- function() {
    e <- globalenv()
    Filter(function(n) !inherits(get(n, envir = e), "dataforge_bridge"), ls(e))
  }

  df$bridge_request <- function(endpoint, params, timeout = NULL) {
    base <- Sys.getenv("DATAFORGE_BRIDGE_URL")
    if (!nzchar(base)) stop("the R/Python bridge is only available inside DataForge", call. = FALSE)
    params$token <- Sys.getenv("DATAFORGE_BRIDGE_TOKEN")
    q <- paste(names(params), vapply(params, function(v) utils::URLencode(enc2utf8(as.character(v)), reserved = TRUE), ""),
               sep = "=", collapse = "&")
    old <- options(timeout = if (is.null(timeout)) 3600 else timeout)
    on.exit(options(old))
    con <- url(paste0(base, endpoint, "?", q), encoding = "UTF-8")
    txt <- tryCatch(paste(readLines(con, warn = FALSE), collapse = ""), finally = close(con))
    res <- jsonlite::fromJSON(txt, simplifyVector = FALSE)
    if (!isTRUE(res$ok)) stop(res$error, call. = FALSE)
    res$value
  }

  df$bridge_pull <- function(lang, name) {
    res <- df$bridge_request("/pull", list(lang = lang, name = name))
    on.exit(unlink(res$path, recursive = TRUE))
    df$dfc_read(res$path)
  }

  df$bridge_push <- function(lang, name, value) {
    path <- file.path(Sys.getenv("DATAFORGE_BRIDGE_DIR"), paste0("r", paste(sample(c(letters, 0:9), 16, TRUE), collapse = "")))
    ok <- FALSE
    on.exit(if (!ok) unlink(path, recursive = TRUE))
    df$dfc_write(value, path)
    df$bridge_request("/push", list(lang = lang, name = name, path = path))
    ok <- TRUE
    invisible(value)
  }

  # `py`: the Python kernel's variables (py$x reads, py$x <- v writes).
  df$py <- structure(list(), class = "dataforge_bridge")
  df$bridge_methods <- list(
    `$.dataforge_bridge` = function(x, name) df$bridge_pull("python", name),
    `[[.dataforge_bridge` = function(x, i, ...) df$bridge_pull("python", i),
    `$<-.dataforge_bridge` = function(x, name, value) { df$bridge_push("python", name, value); x },
    `[[<-.dataforge_bridge` = function(x, i, value) { df$bridge_push("python", i, value); x },
    names.dataforge_bridge = function(x) unlist(df$bridge_request("/names", list(lang = "python"), timeout = 3)),
    length.dataforge_bridge = function(x) 0L,
    print.dataforge_bridge = function(x, ...) {
      cat("<Python bridge>  py$name reads a Python variable, py$name <- value writes one\n")
      invisible(x)
    },
    .DollarNames.dataforge_bridge = function(x, pattern = "") {
      n <- tryCatch(names(x), error = function(e) character())
      n[grepl(pattern, n)]
    }
  )

  # --- debugger ----------------------------------------------------------------
  # R has no DAP server. debugSource() evaluates a script expression by
  # expression and instruments every `{` block (function bodies included) with
  # .dataforge$dbg_step(line, file). A step that should stop pauses inside the
  # kernel and long-polls the host (bridge /debug/wait) for commands.
  df$dbg <- new.env()
  df$dbg$bps <- list()
  df$dbg$mode <- "run"
  df$dbg$depth <- 0L
  df$dbg$top <- 0L
  df$dbg$active <- FALSE
  df$dbg$paused <- FALSE
  df$dbg$frames <- list()
  df$dbg$refs <- list()

  df$dbg_payload_file <- function(x) {
    f <- file.path(Sys.getenv("DATAFORGE_BRIDGE_DIR"), paste0("d", paste(sample(c(letters, 0:9), 16, TRUE), collapse = ""), ".json"))
    jsonlite::write_json(x, f, auto_unbox = TRUE, null = "null", na = "null", digits = NA, force = TRUE)
    f
  }
  df$dbg_emit <- function(x) {
    if (!nzchar(Sys.getenv("DATAFORGE_BRIDGE_URL"))) return(invisible())
    tryCatch(df$bridge_request("/debug/event", list(lang = "r", file = df$dbg_payload_file(x)), timeout = 10),
             error = function(e) NULL)
    invisible()
  }
  df$dbg_reply <- function(id, x) {
    tryCatch(df$bridge_request("/debug/reply", list(lang = "r", id = id, file = df$dbg_payload_file(x)), timeout = 10),
             error = function(e) NULL)
  }

  df$dbg_set_breakpoints <- function(path, lines) {
    df$dbg$bps[[normalizePath(path, mustWork = FALSE)]] <- as.integer(unlist(lines))
    TRUE
  }

  # Insert a step call before every statement of every `{` block.
  df$dbg_instrument <- function(e, file) {
    if (!is.call(e)) return(e)
    head <- e[[1]]
    if (is.name(head) && as.character(head) %in% c("quote", "bquote", "expression", "substitute", "~", "alist")) return(e)
    if (identical(head, as.name("{"))) {
      sr <- attr(e, "srcref")
      out <- list(as.name("{"))
      for (i in seq_along(e)[-1]) {
        line <- if (!is.null(sr) && length(sr) >= i) sr[[i]][1] else NA_integer_
        if (!is.na(line)) out[[length(out) + 1]] <- as.call(list(quote(.dataforge$dbg_step), line, file))
        out[[length(out) + 1]] <- df$dbg_instrument(e[[i]], file)
      }
      return(as.call(out))
    }
    if (identical(head, as.name("function"))) {
      if (length(e) >= 3) {
        b <- e[[3]]
        if (!(is.call(b) && identical(b[[1]], as.name("{")))) {
          # one-line function: give it a step on its own line
          sr <- e[[4]]
          line <- if (!is.null(sr)) sr[[1]] else NA_integer_
          if (!is.na(line)) b <- call("{", as.call(list(quote(.dataforge$dbg_step), line, file)), b)
          e[[3]] <- b
        } else {
          e[[3]] <- df$dbg_instrument(b, file)
        }
      }
      return(e)
    }
    for (i in seq_along(e)[-1]) {
      if (!is.null(e[[i]]) && !identical(e[[i]], quote(expr = ))) e[[i]] <- df$dbg_instrument(e[[i]], file)
    }
    e
  }

  df$dbg_step <- function(line, file, env = parent.frame()) {
    if (df$dbg$paused || (!df$dbg$active && !length(df$dbg$bps))) return(invisible())
    d <- sys.nframe() - 1L
    keep <- as.integer(names(df$dbg$frames)) < d
    df$dbg$frames <- df$dbg$frames[keep]
    name <- if (identical(env, globalenv())) "<script>" else {
      cl <- sys.call(-1)
      if (is.null(cl)) "<top>" else paste(deparse(cl[[1]], width.cutoff = 60)[1])
    }
    df$dbg$frames[[as.character(d)]] <- list(line = line, file = file, env = env, name = name)
    hit <- line %in% df$dbg$bps[[file]]
    m <- df$dbg$mode
    if (hit || m == "in" || (m == "over" && d <= df$dbg$depth) || (m == "out" && d < df$dbg$depth)) {
      df$dbg_pause(d, if (hit) "breakpoint" else "step")
    }
    invisible()
  }

  df$dbg_frame_list <- function() {
    fr <- df$dbg$frames
    ids <- sort(as.integer(names(fr)), decreasing = TRUE)
    lapply(ids, function(i) {
      f <- fr[[as.character(i)]]
      list(id = i, name = f$name, line = f$line, path = f$file)
    })
  }

  df$dbg_ref <- function(x) {
    if (!(is.list(x) || is.environment(x)) || length(x) == 0) return(0L)
    id <- length(df$dbg$refs) + 1L
    df$dbg$refs[[id]] <- x
    id
  }

  df$dbg_var <- function(name, x) {
    list(name = name,
         type = paste(class(x), collapse = "/"),
         value = tryCatch(substr(df$preview(x), 1, 300), error = function(e) "<?>"),
         variablesReference = df$dbg_ref(x))
  }

  df$dbg_variables <- function(cmd) {
    if (!is.null(cmd$ref) && cmd$ref > 0) {
      x <- df$dbg$refs[[cmd$ref]]
      if (is.environment(x)) {
        nms <- utils::head(ls(x), 300)
        return(lapply(nms, function(n) df$dbg_var(n, get(n, envir = x))))
      }
      nms <- names(x)
      if (is.null(nms)) nms <- paste0("[[", seq_along(x), "]]")
      idx <- utils::head(seq_along(x), 300)
      return(lapply(idx, function(i) df$dbg_var(if (nzchar(nms[i])) nms[i] else paste0("[[", i, "]]"), x[[i]])))
    }
    f <- df$dbg$frames[[as.character(cmd$frameId)]]
    if (is.null(f)) return(list())
    env <- f$env
    nms <- ls(env)
    if (identical(env, globalenv())) nms <- Filter(function(n) !inherits(get(n, envir = env), "dataforge_bridge"), nms)
    lapply(utils::head(nms, 300), function(n) {
      v <- tryCatch(get(n, envir = env), error = function(e) structure(conditionMessage(e), class = "dataforge_missing"))
      df$dbg_var(n, v)
    })
  }

  df$dbg_evaluate <- function(cmd) {
    f <- df$dbg$frames[[as.character(cmd$frameId)]]
    env <- if (is.null(f)) globalenv() else f$env
    out <- tryCatch({
      txt <- utils::capture.output(res <- withVisible(eval(parse(text = cmd$expression), envir = env)))
      if (res$visible) txt <- c(txt, utils::capture.output(print(res$value)))
      list(ok = TRUE, result = paste(utils::head(txt, 200), collapse = "\n"),
           variablesReference = if (res$visible) df$dbg_ref(res$value) else 0L)
    }, error = function(e) list(ok = FALSE, result = paste("Error:", conditionMessage(e)), variablesReference = 0L))
    out
  }

  df$dbg_pause <- function(d, reason) {
    df$dbg$paused <- TRUE
    on.exit(df$dbg$paused <- FALSE)
    df$dbg$refs <- list()
    df$dbg_emit(list(event = "stopped", reason = reason, frames = df$dbg_frame_list()))
    repeat {
      cmd <- tryCatch(df$bridge_request("/debug/wait", list(lang = "r"), timeout = 60),
                      error = function(e) list(command = "continue"))
      act <- cmd$command
      if (act == "none") next
      if (act == "continue") { df$dbg$mode <- "run"; break }
      if (act == "next") { df$dbg$mode <- "over"; df$dbg$depth <- d; break }
      if (act == "stepIn") { df$dbg$mode <- "in"; break }
      if (act == "stepOut") { df$dbg$mode <- "out"; df$dbg$depth <- d; break }
      if (act == "terminate") {
        # Unwind with a condition (invokeRestart("abort") would end IRkernel).
        df$dbg$mode <- "run"
        df$dbg$paused <- FALSE
        df$dbg_emit(list(event = "continued"))
        stop(structure(class = c("dataforge_debug_stop", "error", "condition"),
                       list(message = "debugging stopped", call = NULL)))
      }
      if (act == "variables") df$dbg_reply(cmd$id, df$dbg_variables(cmd))
      else if (act == "evaluate") df$dbg_reply(cmd$id, df$dbg_evaluate(cmd))
      else if (act == "setBreakpoints") df$dbg_reply(cmd$id, df$dbg_set_breakpoints(cmd$path, cmd$lines))
    }
    df$dbg_emit(list(event = "continued"))
  }

  # debugSource(): run a script under the debugger (same name as RStudio's).
  df$debugSource <- function(file, echo = FALSE) {
    path <- normalizePath(file, mustWork = TRUE)
    exprs <- parse(path, keep.source = TRUE, encoding = "UTF-8")
    srcrefs <- attr(exprs, "srcref")
    df$dbg$active <- TRUE
    df$dbg$mode <- "run"
    df$dbg$frames <- list()
    df$dbg$top <- sys.nframe()
    df$dbg_emit(list(event = "started", path = path))
    on.exit({
      df$dbg$active <- FALSE
      df$dbg$mode <- "run"
      df$dbg$frames <- list()
      df$dbg_emit(list(event = "terminated"))
    })
    tryCatch({
      for (i in seq_along(exprs)) {
        df$dbg_step(srcrefs[[i]][1], path, env = globalenv())
        e <- df$dbg_instrument(exprs[[i]], path)
        res <- withVisible(eval(e, globalenv()))
        if (res$visible) print(res$value)
      }
    }, dataforge_debug_stop = function(e) NULL)
    invisible()
  }

  # --- reproducibility ------------------------------------------------------------
  # Exact versions of the packages a project uses, plus their dependency closure,
  # in renv.lock terms (Source/Repository or GitHub remote fields).
  df$repro_info <- function(packages = list()) {
    pk <- unique(as.character(unlist(packages)))
    fields <- c("Repository", "RemoteType", "RemoteHost", "RemoteUsername", "RemoteRepo", "RemoteRef", "RemoteSha", "RemoteUrl")
    ip <- utils::installed.packages(fields = fields)
    ip <- ip[!duplicated(rownames(ip)), , drop = FALSE]
    base <- rownames(ip)[ip[, "Priority"] %in% "base"]
    have <- intersect(pk, rownames(ip))
    deps <- if (length(have)) tools::package_dependencies(have, db = ip, which = c("Depends", "Imports", "LinkingTo"), recursive = TRUE) else list()
    all <- setdiff(intersect(unique(c(have, unlist(deps))), rownames(ip)), c(base, "R"))
    f <- function(p, k) { v <- ip[p, k]; if (is.na(v) || !nzchar(v)) NULL else unname(v) }
    pkgs <- lapply(sort(all), function(p) {
      remote <- f(p, "RemoteType")
      e <- list(Package = p, Version = unname(ip[p, "Version"]), direct = p %in% pk)
      if (!is.null(remote) && remote %in% c("github", "gitlab", "bitbucket", "git", "url")) {
        e$Source <- if (remote == "github") "GitHub" else if (remote == "gitlab") "GitLab" else if (remote == "bitbucket") "Bitbucket" else "Git"
        for (k in c("RemoteType", "RemoteHost", "RemoteUsername", "RemoteRepo", "RemoteRef", "RemoteSha", "RemoteUrl")) e[[k]] <- f(p, k)
      } else {
        e$Source <- "Repository"
        e$Repository <- f(p, "Repository") %||% "CRAN"
      }
      e
    })
    repos <- getOption("repos")
    repos[repos == "@CRAN@"] <- "https://cloud.r-project.org"
    list(
      version = paste(R.version$major, R.version$minor, sep = "."),
      platform = R.version$platform,
      os = utils::sessionInfo()$running %||% "",
      repos = lapply(seq_along(repos), function(i) list(Name = names(repos)[i] %||% paste0("repo", i), URL = unname(repos[i]))),
      packages = pkgs,
      missing = I(setdiff(pk, rownames(ip))),
      base = I(intersect(pk, base)),
      renv = if (requireNamespace("renv", quietly = TRUE)) as.character(utils::packageVersion("renv")) else NULL,
      session_info = paste(utils::capture.output(print(utils::sessionInfo())), collapse = "\n")
    )
  }

  # --- extensions: kernel.evaluate() ---------------------------------------------
  df$ext_eval <- function(code) {
    out <- utils::capture.output(res <- withVisible(eval(parse(text = code), envir = globalenv())))
    if (res$visible) out <- c(out, utils::capture.output(print(res$value)))
    paste(utils::head(out, 5000), collapse = "\n")
  }

  # --- packages ---------------------------------------------------------------
  df$packages <- function() {
    ip <- utils::installed.packages(fields = "Title")
    ip <- ip[!duplicated(ip[, "Package"]), , drop = FALSE]
    loaded <- loadedNamespaces()
    attached <- sub("^package:", "", grep("^package:", search(), value = TRUE))
    lapply(seq_len(nrow(ip)), function(i) {
      name <- ip[i, "Package"]
      list(
        name = name,
        version = ip[i, "Version"],
        title = if (is.na(ip[i, "Title"])) NULL else gsub("\\s+", " ", ip[i, "Title"]),
        lib = ip[i, "LibPath"],
        base = isTRUE(ip[i, "Priority"] == "base"),
        loaded = name %in% loaded,
        attached = name %in% attached
      )
    })
  }

  df$packages_outdated <- function() {
    old <- utils::old.packages(repos = getOption("repos"))
    if (is.null(old)) return(list())
    lapply(seq_len(nrow(old)), function(i) list(name = old[i, "Package"], latest = old[i, "ReposVer"]))
  }

  df$lib_info <- function() {
    list(libPaths = I(.libPaths()), renv = isTRUE(nzchar(Sys.getenv("RENV_PROJECT"))),
         repos = I(unname(getOption("repos"))))
  }

  # --- help -------------------------------------------------------------------
  df$help_links <- NULL

  df$help_html <- function(topic, package = NULL) {
    files <- as.character(if (is.null(package)) utils::help(topic) else utils::help(topic, package = (package)))
    if (!length(files)) return(list(found = FALSE, topic = topic))
    pkg_of <- function(f) basename(dirname(dirname(f)))
    if (length(files) > 1) {
      return(list(found = TRUE, topic = topic, choices = lapply(files, function(f) {
        list(topic = basename(f), package = pkg_of(f))
      })))
    }
    file <- files[1]
    pkg <- pkg_of(file)
    rd <- utils:::.getHelpFile(file)
    if (is.null(df$help_links)) df$help_links <- tryCatch(tools::findHTMLlinks(), error = function(e) character())
    html <- paste(utils::capture.output(tools::Rd2HTML(rd, out = "", package = pkg, Links = df$help_links, stylesheet = "")), collapse = "\n")
    body <- sub("(?s).*<body[^>]*>", "", html, perl = TRUE)
    body <- sub("(?s)</body>.*", "", body, perl = TRUE)
    title <- tools:::.Rd_get_title(rd)
    list(found = TRUE, topic = basename(file), package = pkg, title = title, html = body)
  }

  df$help_search <- function(query) {
    hs <- tryCatch(utils::help.search(query, fields = c("alias", "title"), types = "help", agrep = FALSE, ignore.case = TRUE),
                   error = function(e) NULL)
    if (is.null(hs) || !nrow(hs$matches)) return(list())
    m <- hs$matches
    m <- m[!duplicated(paste(m[, "Topic"], m[, "Package"])), , drop = FALSE]
    m <- utils::head(m, 60)
    lapply(seq_len(nrow(m)), function(i) list(topic = m[i, "Topic"], package = m[i, "Package"], title = m[i, "Title"]))
  }

  df$info <- function() {
    list(version = paste(R.version$major, R.version$minor, sep = "."),
         cwd = getwd())
  }

  df$setwd <- function(path) { setwd(path); getwd() }

  # Without a UTF-8 locale R mangles non-ASCII text (common for GUI-launched
  # apps). Switch the character type to UTF-8 when the C library supports it.
  if (!isTRUE(l10n_info()[["UTF-8"]]) && .Platform$OS.type == "unix") {
    for (loc in c("C.UTF-8", "en_US.UTF-8", "UTF-8")) {
      if (nzchar(suppressWarnings(Sys.setlocale("LC_CTYPE", loc)))) break
    }
  }

  options(jupyter.plot_mimetypes = c("image/png", "image/svg+xml", "application/pdf"),
          repr.plot.res = 144, width = 100)

  if ("dataforge:tools" %in% search()) detach("dataforge:tools")
  tools <- new.env()
  assign(".dataforge", df, envir = tools)
  assign("View", df$View, envir = tools)
  assign("py", df$py, envir = tools)
  assign("debugSource", df$debugSource, envir = tools)
  # R >= 3.6 skips attached environments when looking up S3 methods: register them.
  for (m in names(df$bridge_methods)) {
    generic <- sub("\\.dataforge_bridge$", "", m)
    registerS3method(generic, "dataforge_bridge", df$bridge_methods[[m]],
                     envir = if (generic == ".DollarNames") asNamespace("utils") else baseenv())
  }
  attach(tools, name = "dataforge:tools", warn.conflicts = FALSE)
})
invisible(NULL)
