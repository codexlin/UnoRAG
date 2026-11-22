import assert from "node:assert/strict";
import test from "node:test";
import {
	interfaceText,
	isLocale,
	resolveLocale,
} from "../../src/lib/i18n/locale";

test("preferred UI language honors the browser's supported language and quality order", () => {
	for (const [header, locale] of [
		["zh-CN,zh;q=0.9,en;q=0.8", "zh-CN"],
		["en-GB,zh-CN;q=0.9", "en"],
		["FR-FR, ZH-Hant-TW;q=0.8, en;q=0.7", "zh-CN"],
		["fr-FR, zh;q=0.1, en-US;q=0.9", "en"],
		["zh;q=0, en;q=0.8", "en"],
		["zh;q=0.7,en;q=0.7", "zh-CN"],
	]) {
		assert.equal(resolveLocale(undefined, header), locale, header);
	}
});

test("unknown, malformed or missing language hints fall back to English", () => {
	for (const header of [null, "", "*", "ja-JP,fr;q=0.8", "zh;q=2", "zh;q=0"]) {
		assert.equal(resolveLocale(undefined, header), "en");
	}
	assert.equal(resolveLocale("unknown", "zh-CN"), "zh-CN");
});

test("only explicit supported preferences override negotiation", () => {
	assert.equal(resolveLocale("en", "zh-CN"), "en");
	assert.equal(resolveLocale("zh-CN", "en"), "zh-CN");
	assert.equal(resolveLocale("system", "en"), "en");
	assert.equal(isLocale({ locale: "en" }), false);
	assert.equal(interfaceText("en")("知识库", "Library"), "Library");
	assert.equal(interfaceText("zh-CN")("知识库", "Library"), "知识库");
});
