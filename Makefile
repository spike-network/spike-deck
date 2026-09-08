.PHONY: all icons package screenshots screenshots-setup screenshots-check store-upload store-submit store-release store-status store-cancel clean help

NAME := spikedeck
MANIFEST := manifest.json
DIST := dist
VERSION := $(shell node -p "require('./$(MANIFEST)').version")
ZIP := $(DIST)/$(NAME)-$(VERSION).zip

PACK_FILES := \
	manifest.json \
	background.js \
	popup.html popup.css popup.js popup-max-height.js \
	offscreen.html offscreen.js \
	options.html options.css options.js \
	tools.html tools.css tools.js interaction.css \
	design-tokens.css theme.js theme.css \
	lib \
	icons \
	_locales

all: package

icons:
	rsvg-convert -w 16 -h 16 icons/icon.svg -o icons/icon16.png
	rsvg-convert -w 48 -h 48 icons/icon.svg -o icons/icon48.png
	rsvg-convert -w 128 -h 128 icons/icon.svg -o icons/icon128.png

help:
	@echo "make package         Chrome Web Store zip -> $(ZIP)"
	@echo "make screenshots-setup  install pinned screenshot tools and Chromium"
	@echo "make screenshots     1280x800 store screenshots in dist/screenshots/"
	@echo "make screenshots-check  UI layout checks in dist/ui-check/"
	@echo "make store-upload    upload $(ZIP) to the existing CWS item"
	@echo "make store-submit    submit the current CWS draft for review"
	@echo "make store-release   package + upload + submit for review"
	@echo "make store-status    fetch CWS item status"
	@echo "make store-cancel    cancel a pending CWS review"
	@echo "make clean           remove $(DIST)/"

package:
	mkdir -p $(DIST)
	rm -f $(ZIP)
	zip -r -X $(ZIP) $(PACK_FILES) -x "*.DS_Store" "*/.DS_Store"
	@echo "wrote $(ZIP)"

screenshots:
	node store/capture.mjs

screenshots-setup:
	npm ci --prefix store
	cd store && npx playwright install chromium

screenshots-check:
	node store/capture.mjs --check

store-upload: package
	bash scripts/cws.sh upload

store-submit:
	bash scripts/cws.sh submit

store-release: package
	bash scripts/cws.sh release

store-status:
	bash scripts/cws.sh status

store-cancel:
	bash scripts/cws.sh cancel

clean:
	rm -rf $(DIST)
