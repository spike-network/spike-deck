.PHONY: all package screenshots clean help

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
	lib \
	icons

all: package

help:
	@echo "make package      Chrome Web Store zip -> $(ZIP)"
	@echo "make screenshots  1280x800 store screenshots in store/"
	@echo "make clean        remove $(DIST)/"

package:
	mkdir -p $(DIST)
	rm -f $(ZIP)
	zip -r -X $(ZIP) $(PACK_FILES) -x "*.DS_Store" "*/.DS_Store"
	@echo "wrote $(ZIP)"

screenshots:
	bash store/capture.sh

clean:
	rm -rf $(DIST)
