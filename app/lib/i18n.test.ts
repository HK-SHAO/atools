import { describe, expect, test } from "bun:test";
import { applyHead, LANG, pickLang, strings, t, type Key } from "./i18n";

const EN = strings("en");
const ZH = strings("zh");
const KEYS = Object.keys(EN) as Key[];

const holes = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort();

describe("dictionary parity", () => {
  // The types already force zh to carry every key. These cover what the types cannot:
  // a placeholder dropped in one language, or an entry left blank.
  test("both languages carry every key", () => {
    expect(Object.keys(ZH).sort()).toEqual([...KEYS].sort());
  });

  test("a placeholder in one language is a placeholder in the other", () => {
    const drift = KEYS.filter(key => holes(EN[key]).join() !== holes(ZH[key]).join());
    expect(drift, `placeholders differ for: ${drift.join(", ")}`).toEqual([]);
  });

  test("no entry is blank", () => {
    expect(KEYS.filter(key => !EN[key].trim() || !ZH[key].trim())).toEqual([]);
  });
});

describe("pickLang", () => {
  test("every spelling of Chinese lands on zh", () => {
    for (const tag of ["zh", "zh-CN", "zh-Hans", "zh-Hant-TW", "zh_CN", "ZH-cn"]) {
      expect(pickLang([tag]), tag).toBe("zh");
    }
  });

  test("anything else lands on en, an absent list included", () => {
    for (const tags of [undefined, [], ["en-US"], ["ja-JP", "en"], ["zho"], [""]]) {
      expect(pickLang(tags), String(tags)).toBe("en");
    }
  });

  test("Chinese anywhere in the list wins", () => {
    expect(pickLang(["en-GB", "zh-TW"])).toBe("zh");
    expect(pickLang(["fr", "en"])).toBe("en");
  });

  test("the module settled on one of the two", () => {
    expect(["en", "zh"]).toContain(LANG);
  });
});

describe("t", () => {
  test("every declared hole takes the value the caller passes", () => {
    const left = KEYS.flatMap(key => {
      const vars = Object.fromEntries(holes(EN[key]).map(name => [name, "x"]));
      return holes(t(key, vars)).map(name => `${key}:{${name}}`);
    });
    expect(left).toEqual([]);
  });

  test("a hole the caller forgot stays visible instead of vanishing", () => {
    expect(t("verifying", {})).toContain("{pct}");
    expect(t("verifying", { total: "40" })).toContain("{pct}");
  });

  test("values ride across whole, whatever they contain", () => {
    expect(t("verifying", { pct: "40" })).toBe(EN.verifying.replace("{pct}", "40"));
    expect(t("credit", { name: "SPECTRUM v1.0.1" })).toBe(
      EN.credit.replace("{name}", "SPECTRUM v1.0.1"),
    );
  });
});

describe("applyHead", () => {
  test("moves the document language and title with the dictionary", () => {
    const fake = { documentElement: { lang: "" }, title: "" };
    const globals = globalThis as { document?: typeof fake };
    globals.document = fake;
    try {
      applyHead("zh");
      expect(fake.documentElement.lang).toBe("zh");
      expect(fake.title).toBe(ZH.title);

      applyHead("en");
      expect(fake.documentElement.lang).toBe("en");
      expect(fake.title).toBe(EN.title);
    } finally {
      delete globals.document;
    }
  });
});
