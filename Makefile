.PHONY: all package screenshots store-upload store-submit store-release store-status store-cancel clean help

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
	lib \
	icons \
	_locales

all: package

help:
	@echo "make package         Chrome Web Store zip -> $(ZIP)"
	@echo "make screenshots     1280x800 store screenshots in store/"
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
	bash store/capture.sh

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
