# Development helpers for the GNOME Shell extension. Run `make help` for the list.

SRC       := $(CURDIR)/gnome-extension
UUID      := $(shell sed -nE 's/.*"uuid": *"([^"]+)".*/\1/p' $(SRC)/metadata.json)
EXT_DIR   := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
# The ID of versions before 1.0.0, whose link and setting `make install` removes.
OLD_UUID  := claude-meter@atiq-rahman.github.io
OLD_DIR   := $(HOME)/.local/share/gnome-shell/extensions/$(OLD_UUID)
DEV_CACHE := $(CURDIR)/.dev/cache
LEGACY    := $(CURDIR)/build/legacy
# System tools: Homebrew versions earlier in PATH can't reach dconf or compile schemas
# the shell reads.
GSETTINGS := /usr/bin/gsettings
COMPILE   := $(firstword $(wildcard /usr/bin/glib-compile-schemas) glib-compile-schemas)

SHELL_MAJOR := $(shell gnome-shell --version 2>/dev/null | sed -nE 's/^GNOME Shell ([0-9]+).*/\1/p')
# GNOME 42-44 load the copy that dev/build-legacy.sh converts from gnome-extension/.
OLD_SHELL := $(filter 42 43 44,$(SHELL_MAJOR))
LINK_SRC  := $(if $(OLD_SHELL),$(LEGACY),$(SRC))

# Fake reading for `make fake`: session, weekly and one model's weekly percent.
S ?= 38
W ?= 35
M ?= 12

.PHONY: help schemas install uninstall link unlink enable disable prefs nested fake reset-alerts legacy unit test test-all lint logs pack release clean

help: ## Show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-13s %s\n", $$1, $$2}'

schemas: ## Compile the settings schema in gnome-extension/schemas, for running from the source tree
	$(COMPILE) --strict $(SRC)/schemas

install: link enable ## Link and enable the extension (the live session loads it at next login)

uninstall: disable unlink ## Disable and unlink the extension

link: $(if $(OLD_SHELL),legacy,schemas) ## Symlink the extension into ~/.local/share/gnome-shell/extensions
	@mkdir -p $(dir $(EXT_DIR))
	@case "$$(readlink $(OLD_DIR))" in $(CURDIR)/*) rm -f $(OLD_DIR); echo "Removed the link of the old ID $(OLD_UUID)";; esac
	ln -sfn $(LINK_SRC) $(EXT_DIR)

unlink: ## Remove the symlink
	@[ ! -e $(EXT_DIR) ] || [ -L $(EXT_DIR) ] || { echo "$(EXT_DIR) is not a symlink, leaving it alone"; exit 1; }
	rm -f $(EXT_DIR)

# The running shell only knows extensions it found at login, so gnome-extensions
# refuses new ones; then edit the gsettings lists directly, like install.sh does.
enable: ## Add the extension to enabled-extensions
	@$(call drop,enabled-extensions,$(OLD_UUID))
	@if gnome-extensions enable $(UUID) 2>/dev/null; then \
	  echo "Enabled $(UUID)"; \
	else \
	  $(call drop,disabled-extensions,$(UUID)); \
	  list=$$($(GSETTINGS) get org.gnome.shell enabled-extensions); \
	  case "$$list" in \
	    *"'$(UUID)'"*) ;; \
	    *"[]") $(GSETTINGS) set org.gnome.shell enabled-extensions "['$(UUID)']" ;; \
	    *) $(GSETTINGS) set org.gnome.shell enabled-extensions "$${list%]}, '$(UUID)']" ;; \
	  esac; \
	  echo "Enabled $(UUID), but the running shell hasn't loaded it yet: log out and back in"; \
	fi

disable: ## Remove the extension from enabled-extensions
	@gnome-extensions disable $(UUID) 2>/dev/null || $(call drop,enabled-extensions,$(UUID))
	@echo "Disabled $(UUID)"

# Remove extension $(2) from the org.gnome.shell list key $(1).
drop = $(GSETTINGS) set org.gnome.shell $(1) \
	"$$($(GSETTINGS) get org.gnome.shell $(1) | sed "s/, '$(2)'//; s/'$(2)', //; s/'$(2)'//")"

prefs: ## Open the settings window of the extension in your session
	gnome-extensions prefs $(UUID)

nested: $(if $(OLD_SHELL),legacy,schemas) fake ## Run GNOME Shell in a window with the extension and a fresh fake reading: make nested S=92
	$(CURDIR)/dev/nested.sh $(LINK_SRC)

fake: ## Write a fake reading for the nested shell: make fake S=92 W=40 M=63 (M: Fable weekly)
	@mkdir -p $(DEV_CACHE)/claude-meter
	@now=$$(date +%s); s_reset=$$((now + 2*3600 + 600)); w_reset=$$((now + 3*86400 + 5*3600)); \
	printf '{"five_hour":{"used_percentage":%s,"resets_at":%d},"seven_day":{"used_percentage":%s,"resets_at":%d},"model":"Fake","updated_at":%d}\n' \
		$(S) $$s_reset $(W) $$w_reset $$now > $(DEV_CACHE)/claude-meter/usage.json; \
	printf '{"five_hour":{"used_percentage":%s,"resets_at":%d},"seven_day":{"used_percentage":%s,"resets_at":%d},"plan":"Max (5x)","limits":[{"title":"Week · Fable","used_percentage":%s,"resets_at":%d}],"extra_usage":{"enabled":true,"used_percentage":25,"used":"$$12.50","limit":"$$50.00"},"updated_at":%d}\n' \
		$(S) $$s_reset $(W) $$w_reset $(M) $$w_reset $$now > $(DEV_CACHE)/claude-meter/account.json
	@echo "Session $(S)%, week $(W)%, Fable week $(M)% -> $(DEV_CACHE)/claude-meter/ (the meter reads it within 10 s)"

reset-alerts: ## Forget which alerts already fired in the nested shell
	rm -f $(DEV_CACHE)/claude-meter/alerts.json

legacy: ## Build the GNOME 42-44 copy in build/legacy
	@$(CURDIR)/dev/build-legacy.sh $(LEGACY)

unit: ## Quick tests without GNOME Shell: usage parsers, smart quota refresh and the browser's native host
	$(CURDIR)/dev/unit-test.sh

test: unit $(if $(OLD_SHELL),legacy) ## Unit tests, then a headless smoke test on this machine's GNOME Shell, no window or sound
	$(CURDIR)/dev/smoke-test.sh $(LINK_SRC)

test-all: ## Smoke test on GNOME 42-51 in throwaway Docker containers (downloads ~1 GB per version); V="42 45" picks versions
	$(CURDIR)/dev/test-all.sh $(V)

lint: pack ## Check the zips with shexli, as extensions.gnome.org's review guidelines recommend
	$(CURDIR)/dev/lint.sh $(CURDIR)/dist/$(UUID).shell-extension.zip $(CURDIR)/dist/$(UUID).legacy.shell-extension.zip

logs: ## Follow GNOME Shell logs of your real session
	journalctl --user -f -o cat /usr/bin/gnome-shell

pack: legacy ## Build installable zips in dist/ for GNOME 45-51 and 42-44 (.legacy)
	@command -v zip >/dev/null || { echo "Needs zip: sudo apt install zip"; exit 1; }
	@mkdir -p $(CURDIR)/dist
	gnome-extensions pack $(SRC) --extra-source=account.js --extra-source=quota.js --force --out-dir=$(CURDIR)/dist
	gnome-extensions pack $(LEGACY) --extra-source=account.js --extra-source=quota.js --force --out-dir=$(CURDIR)/build
	@# GNOME 42 and 43 don't compile the schema when they install an extension.
	cd $(LEGACY) && zip -q $(CURDIR)/build/$(UUID).shell-extension.zip schemas/gschemas.compiled
	mv $(CURDIR)/build/$(UUID).shell-extension.zip $(CURDIR)/dist/$(UUID).legacy.shell-extension.zip

release: ## Build the release files in dist/release, as the Release workflow does
	$(CURDIR)/dev/package-release.sh

clean: ## Remove .dev/, build/, dist/ and the compiled schema
	rm -rf $(CURDIR)/.dev $(CURDIR)/build $(CURDIR)/dist $(SRC)/schemas/gschemas.compiled
