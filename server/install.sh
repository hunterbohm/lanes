#!/usr/bin/env bash
# Installs the Lanes server for this user: the `lanes` command in ~/.local/bin and its page in ~/.local/share/lanes.
#   ./install.sh          on every machine with runners (the hub runs `~/.local/bin/lanes agent` there over SSH)
#   ./install.sh --hub    also, on the one machine that gathers the others: a systemd user service running
#                         `lanes hub`, and an example ~/.config/lanes/hub.toml if there is none
set -euo pipefail
cd "$(dirname "$0")"

python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || { echo "lanes needs Python 3.11 or newer" >&2; exit 1; }
install -Dm755 lanes "$HOME/.local/bin/lanes"
install -Dm644 lanes.html "$HOME/.local/share/lanes/lanes.html"
echo "installed ~/.local/bin/lanes $("$HOME/.local/bin/lanes" --version)"
# The agent reads runner output from the system journal, which needs the systemd-journal (or adm) group.
if ! id -nG | grep -qwE 'systemd-journal|adm|wheel|root'; then
  echo "note: $USER can't read the system journal, so runner jobs won't show. Run: sudo usermod -aG systemd-journal $USER"
fi

[[ "${1:-}" == "--hub" ]] || exit 0

config="${XDG_CONFIG_HOME:-$HOME/.config}/lanes/hub.toml"
if [[ ! -f $config ]]; then
  install -Dm644 hub.example.toml "$config"
  echo "wrote $config: list your machines there"
fi
install -Dm644 lanes.service "$HOME/.config/systemd/user/lanes.service"
systemctl --user daemon-reload
systemctl --user enable lanes.service
systemctl --user restart lanes.service      # picks up a newer lanes on reinstall
# Keep the hub running while you're logged out.
loginctl enable-linger "$USER" 2>/dev/null || echo "run 'sudo loginctl enable-linger $USER' so the hub runs while you're logged out"
echo "lanes hub is running: http://127.0.0.1:8792/"
