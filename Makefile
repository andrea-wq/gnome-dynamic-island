UUID = dynamic-island@notch-dev
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all compile install uninstall pack check

all: compile

compile:
	glib-compile-schemas --strict schemas/

install: compile
	./install.sh

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(EXT_DIR)

pack: compile
	gnome-extensions pack --force \
		--extra-source=island.js \
		--extra-source=stylesheet.css \
		--extra-source=sources \
		--extra-source=tools \
		--extra-source=schemas \
		--out-dir=.

check: compile
	python3 -m json.tool metadata.json >/dev/null
	test -x tools/drop-catcher.js
