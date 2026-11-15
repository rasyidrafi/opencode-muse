import { describe, expect, test } from "bun:test";
import { Provider } from "@opencode/plugin";
import { contributorModelEntries, serveArgs, toModelInfo, type CatalogRow } from "../src/index.js";

const providerID = Provider.ID.make("muse");

const visible = [
  {
    modelId: "muse-spark-1.3",
    displayLabel: "muse-spark-1.3",
    contextLimit: 1007997,
    outputLimit: 128000,
    variants: ["minimal", "high"],
    releaseDate: "2026-09-02",
  },
  {
    modelId: "muse-ember-1.0",
    displayLabel: "muse-ember-1.0",
    contextLimit: 1007997,
    outputLimit: 128000,
    variants: ["minimal", "high"],
    releaseDate: "2026-10-01",
  },
];

describe("contributorModelEntries", () => {
  test("clones the base row under the contributor id", () => {
    const rows: CatalogRow[] = [
      {
        model_id: "muse-spark-1.3-contributor",
        display_label: "muse-spark-1.3-contributor",
        description: "Your content may be used for product improvement.",
      },
    ];
    const entries = contributorModelEntries(visible, rows);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      modelId: "muse-spark-1.3-contributor",
      displayLabel: "muse-spark-1.3-contributor",
      description: "Your content may be used for product improvement.",
      contextLimit: 1007997,
      outputLimit: 128000,
      variants: ["minimal", "high"],
      releaseDate: "2026-09-02",
    });
  });

  test("a contributor row with no visible base model contributes nothing", () => {
    const rows: CatalogRow[] = [
      { model_id: "muse-unknown-1.0-contributor", display_label: "x", description: null },
    ];
    expect(contributorModelEntries(visible, rows)).toEqual([]);
  });

  test("rows without the contributor suffix are ignored", () => {
    const rows: CatalogRow[] = [{ model_id: "muse-image-1.0", display_label: "x", description: null }];
    expect(contributorModelEntries(visible, rows)).toEqual([]);
  });

  test("a missing description leaves the base row untouched", () => {
    const rows: CatalogRow[] = [
      { model_id: "muse-ember-1.0-contributor", display_label: "muse-ember-1.0-contributor", description: null },
    ];
    expect(contributorModelEntries(visible, rows)[0]).not.toHaveProperty("description");
  });
});

describe("toModelInfo", () => {
  test("names contributor entries the way models.dev does", () => {
    const name = (modelId: string) =>
      toModelInfo(providerID, { modelId, displayLabel: modelId }).name;
    expect(name("muse-spark-1.3")).toBe("Muse Spark 1.3");
    expect(name("muse-spark-1.3-contributor")).toBe("Muse Spark 1.3 Contributor");
    expect(name("muse-ember-1.0")).toBe("Muse Ember");
  });
});

describe("serveArgs", () => {
  test("forwards the preset, contributor mode, and trust flag", () => {
    expect(serveArgs({ preset: "empty", contributorMode: "off", trustWorkspace: true })).toEqual([
      "serve",
      "--preset",
      "empty",
      "--contributor-mode",
      "off",
      "--trust-workspace",
    ]);
  });

  test("omits flags that are not set", () => {
    expect(serveArgs({})).toEqual(["serve"]);
  });
});
