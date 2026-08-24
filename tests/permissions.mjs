import assert from "node:assert/strict";
import { test } from "node:test";
import {
    originPatternFromUrl,
    isLocalOrigin,
    hasHostPermission,
    requestHostPermission,
    ensureHostPermission,
} from "../lib/permissions.js";

test("originPatternFromUrl formats standard URLs correctly", () => {
    assert.equal(
        originPatternFromUrl("http://127.0.0.1:9090"),
        "http://127.0.0.1/*",
    );
    assert.equal(
        originPatternFromUrl("http://localhost:9090/spike/status"),
        "http://localhost/*",
    );
    assert.equal(
        originPatternFromUrl("https://spike.example.com:8443/ctrl"),
        "https://spike.example.com/*",
    );
    assert.equal(
        originPatternFromUrl("http://192.168.1.100:9090"),
        "http://192.168.1.100/*",
    );
    assert.equal(originPatternFromUrl("http://[::1]:9090"), "http://[::1]/*");
    assert.equal(originPatternFromUrl("ftp://127.0.0.1:9090"), null);
    assert.equal(originPatternFromUrl(""), null);
    assert.equal(originPatternFromUrl(null), null);
    assert.equal(originPatternFromUrl("invalid-url"), null);
});

test("isLocalOrigin identifies local hostnames", () => {
    assert.equal(isLocalOrigin("http://127.0.0.1:9090"), true);
    assert.equal(isLocalOrigin("http://localhost:9090"), true);
    assert.equal(isLocalOrigin("http://[::1]:9090"), true);
    assert.equal(isLocalOrigin("https://127.0.0.1"), true);
    assert.equal(isLocalOrigin("http://192.168.1.100:9090"), false);
    assert.equal(isLocalOrigin("https://spike.example.com"), false);
    assert.equal(isLocalOrigin(""), false);
    assert.equal(isLocalOrigin(null), false);
});

test("hasHostPermission & ensureHostPermission bypass local origins", async () => {
    assert.equal(await hasHostPermission("http://127.0.0.1:9090"), true);
    assert.equal(await hasHostPermission("http://localhost:9090"), true);
    assert.equal(await requestHostPermission("http://127.0.0.1:9090"), true);
    assert.equal(await ensureHostPermission("http://127.0.0.1:9090"), true);
});

test("hasHostPermission & requestHostPermission interact with chrome.permissions mock", async () => {
    const grantedOrigins = new Set();
    globalThis.chrome = {
        permissions: {
            async contains({ origins }) {
                return origins.every((o) => grantedOrigins.has(o));
            },
            async request({ origins }) {
                origins.forEach((o) => grantedOrigins.add(o));
                return true;
            },
        },
    };

    const remoteUrl = "https://spike.custom-domain.org:9090";
    const pattern = "https://spike.custom-domain.org/*";

    assert.equal(await hasHostPermission(remoteUrl), false);
    assert.equal(await ensureHostPermission(remoteUrl), true);
    assert.equal(grantedOrigins.has(pattern), true);
    assert.equal(await hasHostPermission(remoteUrl), true);

    delete globalThis.chrome;
});
