# DataForge remote container: R + Python kernels behind an SSH server.
# See README.md next to this file (or docs/REMOTE.md).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server git ca-certificates procps \
      r-base-core r-cran-irkernel r-cran-jsonlite \
      python3 python3-ipykernel python3-pandas python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config

ARG USER=ana
RUN useradd -m -s /bin/bash "$USER" && mkdir -p "/home/$USER/work" && chown "$USER:$USER" "/home/$USER/work"
ENV DF_USER=$USER

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
