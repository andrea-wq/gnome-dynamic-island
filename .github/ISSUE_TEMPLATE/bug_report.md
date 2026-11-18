name: Bug report
description: Segnala un problema con GNOME Dynamic Island e Pill
title: "[Bug]: "
labels: ["bug"]
body:
  - type: textarea
    id: description
    attributes:
      label: Descrizione del problema
      description: Spiega cosa succede e cosa ti aspettavi.
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Passaggi per riprodurre
      placeholder: |
        1. Apri...
        2. Trascina...
  - type: input
    id: environment
    attributes:
      label: Ambiente (Distro, GNOME Shell, Sessione)
      placeholder: "Fedora 45, GNOME Shell 51.0, Wayland"
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: Output journalctl
      description: Esegui `journalctl --user -b _COMM=gnome-shell --since "5 min ago"`
      render: shell
