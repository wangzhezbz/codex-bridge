import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  CODEXBRIDGE_MANAGED_TOML_END,
  CODEXBRIDGE_MANAGED_TOML_START,
  buildConfigMutationDraft,
  inspectManagedCodexTomlBlock,
  materializeConfigMutationEntries,
  removeManagedCodexTomlBlock,
  replaceManagedCodexTomlBlock,
  validateConfigMutationDraft,
} from "../desktop/config-mutation.mjs";

const SECRET = "sk-draft-secret-must-never-enter-errors";

function safeErrorSnapshot(error) {
  return JSON.stringify(Object.fromEntries(
    Object.getOwnPropertyNames(error).map((name) => [name, error[name]]),
  ));
}

function managedBlock({
  model = "cb-route-a",
  catalogPath = "C:/Temp/codex-catalog.json",
  mode = "hybrid",
  port = 15722,
} = {}) {
  const providerLines = mode === "all_api"
    ? [
        'model_provider = "codexbridge"',
        `model_providers.codexbridge.base_url = "http://127.0.0.1:${port}/v1"`,
        'model_providers.codexbridge.wire_api = "responses"',
        "model_providers.codexbridge.requires_openai_auth = false",
        'model_providers.codexbridge.http_headers = { Authorization = "Bearer sk-local-codex-router" }',
      ]
    : [
        'model_provider = "openai"',
        `openai_base_url = "http://127.0.0.1:${port}/v1"`,
      ];
  return [
    CODEXBRIDGE_MANAGED_TOML_START,
    `model = "${model}"`,
    `model_catalog_json = "${catalogPath}"`,
    ...providerLines,
    CODEXBRIDGE_MANAGED_TOML_END,
  ].join("\n");
}

test("managed TOML replacement preserves every unrelated CRLF byte including Unicode, comments, plugins, and MCP", () => {
  const prefix = Buffer.from("# 用户自己的注释\r\napproval_policy = \"on-request\"\r\n", "utf8");
  const oldBlock = Buffer.from([
    CODEXBRIDGE_MANAGED_TOML_START,
    'model = "cb-old"',
    CODEXBRIDGE_MANAGED_TOML_END,
  ].join("\r\n"), "utf8");
  const suffix = Buffer.from(
    "\r\n\r\n[plugins.github]\r\nenabled = true # 保留\r\n\r\n[mcp_servers.node_repl]\r\ncommand = \"node\"\r\n",
    "utf8",
  );
  const original = Buffer.concat([prefix, oldBlock, suffix]);

  const actual = replaceManagedCodexTomlBlock(original, managedBlock());
  const replacementBytes = Buffer.from(managedBlock().replaceAll("\n", "\r\n"), "utf8");

  assert.deepEqual(actual, Buffer.concat([prefix, replacementBytes, suffix]));
  assert.deepEqual(actual.subarray(0, prefix.length), prefix);
  assert.deepEqual(actual.subarray(actual.length - suffix.length), suffix);
  assert.deepEqual(inspectManagedCodexTomlBlock(actual), {
    state: "managed",
    newline: "\r\n",
    startOffset: prefix.length,
    endOffset: prefix.length + replacementBytes.length,
  });
});

test("managed TOML replacement rejects duplicate, partial, reversed, nested, and malformed markers", () => {
  const invalidInputs = [
    `${CODEXBRIDGE_MANAGED_TOML_START}\nold\n${CODEXBRIDGE_MANAGED_TOML_START}\n${CODEXBRIDGE_MANAGED_TOML_END}\n`,
    `${CODEXBRIDGE_MANAGED_TOML_START}\nold\n`,
    `${CODEXBRIDGE_MANAGED_TOML_END}\nold\n`,
    `${CODEXBRIDGE_MANAGED_TOML_END}\n${CODEXBRIDGE_MANAGED_TOML_START}\n`,
    `${CODEXBRIDGE_MANAGED_TOML_START}\n${CODEXBRIDGE_MANAGED_TOML_START}\n${CODEXBRIDGE_MANAGED_TOML_END}\n${CODEXBRIDGE_MANAGED_TOML_END}\n`,
    "# >>> CodexBridge managed config trailing-junk\n",
    "# >>> CodexBridge managed\n",
    "# <<< CodexBridge managed configuration\n",
  ];

  for (const input of invalidInputs) {
    assert.throws(
      () => replaceManagedCodexTomlBlock(Buffer.from(input), managedBlock()),
      (error) => error?.code === "managed_toml_invalid",
      input,
    );
  }

  assert.throws(
    () => replaceManagedCodexTomlBlock(Buffer.from(""), `${managedBlock()}\n${CODEXBRIDGE_MANAGED_TOML_END}`),
    (error) => error?.code === "managed_toml_replacement_invalid",
  );
});

test("managed TOML insertion is deterministic, preserves a UTF-8 BOM and original bytes, and is idempotent", () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const originalBody = Buffer.from(
    "# 原始文件\r\n[plugins.github]\r\nenabled = true\r\n",
    "utf8",
  );
  const original = Buffer.concat([bom, originalBody]);
  const block = managedBlock();
  const expectedBlock = Buffer.from(block.replaceAll("\n", "\r\n"), "utf8");

  const first = replaceManagedCodexTomlBlock(original, block);
  const second = replaceManagedCodexTomlBlock(first, block);

  assert.deepEqual(
    first,
    Buffer.concat([bom, expectedBlock, Buffer.from("\r\n\r\n"), originalBody]),
  );
  assert.deepEqual(second, first);
  assert.equal(inspectManagedCodexTomlBlock(first).state, "managed");
});

test("managed TOML removal removes only the validated block and preserves surrounding bytes", () => {
  const prefix = Buffer.from("# before\n", "utf8");
  const block = Buffer.from(managedBlock(), "utf8");
  const suffix = Buffer.from("\n# after\n[plugins.keep]\nenabled = true\n", "utf8");
  const original = Buffer.concat([prefix, block, suffix]);

  assert.deepEqual(removeManagedCodexTomlBlock(original), Buffer.concat([prefix, suffix]));
  const unmanaged = Buffer.from("# untouched\r\n[plugins.keep]\r\nenabled = true\r\n");
  assert.deepEqual(removeManagedCodexTomlBlock(unmanaged), unmanaged);
  assert.throws(
    () => removeManagedCodexTomlBlock(Buffer.from(`${CODEXBRIDGE_MANAGED_TOML_START}\n`)),
    (error) => error?.code === "managed_toml_invalid",
  );
});

function validDraftSpec(overrides = {}) {
  const base = path.resolve("C:/Temp/codexbridge-config-mutation-fixture");
  const codexCatalogTarget = path.join(base, "home", ".codex", "codexbridge-model-catalog.json");
  const draftMode = overrides.mode ?? "hybrid";
  const selectionValue = {
    mode: draftMode,
    selectedModelIds: ["preset-a", "preset-b"],
  };
  const optionsValue = {
    routerPort: 15722,
    interceptCodexAuxiliaryTasks: true,
  };
  const sourceValue = {
    providers: {
      providerA: { apiKey: SECRET, baseUrl: "https://example.invalid/v1" },
    },
  };

  return {
    operation: "providers:save",
    configRevision: "revision-pure-draft-1",
    mode: draftMode,
    sources: [
      {
        id: "providerOverrides",
        target: path.join(base, "config", "provider-overrides.json"),
        value: sourceValue,
        sensitive: true,
        originalBytes: Buffer.from('{"providers":{}}\r\n'),
      },
    ],
    selection: {
      target: path.join(base, "config", "model-selection.json"),
      value: selectionValue,
      originalBytes: Buffer.from('{"mode":"hybrid","selectedModelIds":["preset-a"]}\n'),
    },
    options: {
      target: path.join(base, "config", "desktop-options.json"),
      value: optionsValue,
      originalBytes: null,
    },
    router: {
      target: path.join(base, "config", "router.config.json"),
    },
    rootCatalog: {
      target: path.join(base, "model-catalog.json"),
    },
    codexCatalog: {
      target: codexCatalogTarget,
    },
    codexConfig: {
      target: path.join(base, "home", ".codex", "config.toml"),
      currentBytes: Buffer.from(
        "# 用户配置\r\n[plugins.github]\r\nenabled = true\r\n",
        "utf8",
      ),
    },
    allowManagedBlockInsert: true,
    buildRouterConfig({ configRevision, mode, selection, options, sources }) {
      assert.equal(Object.isFrozen(selection), true);
      assert.equal(Object.isFrozen(selection.selectedModelIds), true);
      assert.equal(Object.isFrozen(options), true);
      assert.equal(Object.isFrozen(sources), true);
      assert.equal(Object.isFrozen(sources.providerOverrides), true);
      return {
        configRevision,
        mode,
        port: options.routerPort,
        defaultModel: "cb-route-a",
        models: [
          { id: "cb-route-a", sourcePresetId: selection.selectedModelIds[0] },
          { id: "cb-route-b", sourcePresetId: selection.selectedModelIds[1] },
        ],
      };
    },
    buildRootCatalog({ routerConfig }) {
      return {
        models: routerConfig.models.map(({ id }) => ({ slug: id, source: "shared" })),
      };
    },
    buildCodexCatalog({ routerConfig }) {
      return {
        models: routerConfig.models.map(({ id }) => ({ slug: id, source: "shared" })),
      };
    },
    buildManagedCodexBlock({ routerConfig }) {
      return managedBlock({
        model: routerConfig.defaultModel,
        catalogPath: codexCatalogTarget.replaceAll("\\", "/"),
        mode: routerConfig.mode,
        port: routerConfig.port,
      });
    },
    ...overrides,
  };
}

test("buildConfigMutationDraft creates an immutable seven-file in-memory draft with fresh materializations", () => {
  const spec = validDraftSpec();
  const originalSource = structuredClone(spec.sources[0].value);
  const draft = buildConfigMutationDraft(spec);

  assert.deepEqual(spec.sources[0].value, originalSource);
  assert.equal(Object.isFrozen(draft), true);
  assert.equal(Object.isFrozen(draft.candidates), true);
  assert.equal(validateConfigMutationDraft(draft), true);
  assert.throws(() => draft.candidates.push({}), TypeError);
  assert.deepEqual(
    draft.candidates.map(({ id, role, sensitive, mode }) => ({ id, role, sensitive, mode })),
    [
      { id: "source:providerOverrides", role: "source", sensitive: true, mode: 0o600 },
      { id: "selection", role: "selection", sensitive: false, mode: undefined },
      { id: "options", role: "options", sensitive: false, mode: undefined },
      { id: "routerConfig", role: "router", sensitive: false, mode: undefined },
      { id: "rootCatalog", role: "root_catalog", sensitive: false, mode: undefined },
      { id: "codexCatalog", role: "codex_catalog", sensitive: false, mode: undefined },
      { id: "codexConfig", role: "managed_toml", sensitive: true, mode: 0o600 },
    ],
  );

  const first = materializeConfigMutationEntries(draft);
  const second = materializeConfigMutationEntries(draft);
  assert.notEqual(first, second);
  assert.notEqual(first[0].content, second[0].content);
  assert.equal(first[0].mode, 0o600);
  assert.equal(first[0].sensitive, true);
  assert.equal(first[1].sensitive, false);
  assert.equal(first[6].sensitive, true);
  assert.equal(first[6].mode, 0o600);
  assert.deepEqual(first[0].expectedOriginal, {
    exists: true,
    bytes: spec.sources[0].originalBytes,
  });
  assert.deepEqual(first[2].expectedOriginal, { exists: false });
  assert.equal(JSON.parse(first[0].content).providers.providerA.apiKey, SECRET);
  assert.equal(JSON.parse(first[1].content).mode, "hybrid");
  assert.equal(JSON.parse(first[3].content).configRevision, "revision-pure-draft-1");
  assert.deepEqual(
    JSON.parse(first[4].content).models.map(({ slug }) => slug),
    ["cb-route-a", "cb-route-b"],
  );
  assert.match(first[6].content.toString("utf8"), /\[plugins\.github\]/);

  first[0].content.fill(0);
  first[0].expectedOriginal.bytes.fill(0);
  const third = materializeConfigMutationEntries(draft);
  assert.equal(JSON.parse(third[0].content).providers.providerA.apiKey, SECRET);
  assert.deepEqual(third[0].expectedOriginal, {
    exists: true,
    bytes: spec.sources[0].originalBytes,
  });
});

test("an absent Codex config uses empty current bytes for insertion but exists:false for CAS", () => {
  const spec = validDraftSpec();
  spec.codexConfig = {
    ...spec.codexConfig,
    currentBytes: Buffer.alloc(0),
    originalBytes: null,
  };

  const draft = buildConfigMutationDraft(spec);
  const codexEntry = materializeConfigMutationEntries(draft).find(({ id }) => id === "codexConfig");

  assert.deepEqual(codexEntry.expectedOriginal, { exists: false });
  assert.equal(codexEntry.content.toString("utf8"), `${managedBlock({
    catalogPath: spec.codexCatalog.target.replaceAll("\\", "/"),
  })}\n`);
});

test("an existing empty Codex config remains distinct from a missing Codex config in CAS", () => {
  const spec = validDraftSpec();
  spec.codexConfig = {
    ...spec.codexConfig,
    currentBytes: Buffer.alloc(0),
    originalBytes: Buffer.alloc(0),
  };

  const codexEntry = materializeConfigMutationEntries(
    buildConfigMutationDraft(spec),
  ).find(({ id }) => id === "codexConfig");

  assert.deepEqual(codexEntry.expectedOriginal, {
    exists: true,
    bytes: Buffer.alloc(0),
  });
});

test("managed block insertion is denied by default and never invokes the TOML block builder", () => {
  let managedBlockBuilds = 0;
  const spec = validDraftSpec({
    allowManagedBlockInsert: false,
    buildManagedCodexBlock() {
      managedBlockBuilds += 1;
      return managedBlock();
    },
  });

  assert.throws(
    () => buildConfigMutationDraft(spec),
    (error) => error?.code === "config_draft_toml_unmanaged",
  );
  assert.equal(managedBlockBuilds, 0);
});

test("explicit first install rejects unmanaged TOML that already owns a managed key or CodexBridge provider namespace", () => {
  const conflictingToml = [
    'approval_policy = "on-request"\n',
    'sandbox_mode = "workspace-write"\n',
    'model = "gpt-user-owned"\n',
    'model_provider = "user-provider"\n',
    'model_catalog_json = "C:/user/catalog.json"\n',
    'model_reasoning_effort = "high"\n',
    'model_providers = { user = { name = "User provider" } }\n',
    '"model_providers" = {}\n',
    '"model\\u005fproviders" = {}\n',
    '[[model_providers]]\nname = "User provider"\n',
    'model_providers.codexbridge.base_url = "https://user.invalid/v1"\n',
    '[model_providers.codexbridge]\nbase_url = "https://user.invalid/v1"\n',
  ];

  for (const currentToml of conflictingToml) {
    let managedBlockBuilds = 0;
    const spec = validDraftSpec({
      codexConfig: {
        ...validDraftSpec().codexConfig,
        currentBytes: Buffer.from(currentToml, "utf8"),
      },
      allowManagedBlockInsert: true,
      buildManagedCodexBlock() {
        managedBlockBuilds += 1;
        return managedBlock();
      },
    });

    assert.throws(
      () => buildConfigMutationDraft(spec),
      (error) => error?.code === "config_draft_toml_conflict",
      currentToml,
    );
    assert.equal(managedBlockBuilds, 0, currentToml);
  }
});

test("explicit first install preserves a shared model_providers table owned by other providers", () => {
  const currentToml = [
    "[model_providers]",
    'user = { name = "User provider", base_url = "https://user.invalid/v1" }',
    "",
  ].join("\n");
  const spec = validDraftSpec({
    codexConfig: {
      ...validDraftSpec().codexConfig,
      currentBytes: Buffer.from(currentToml, "utf8"),
    },
    allowManagedBlockInsert: true,
  });

  const draft = buildConfigMutationDraft(spec);
  const codexEntry = materializeConfigMutationEntries(draft).find(({ id }) => id === "codexConfig");
  const nextToml = codexEntry.content.toString("utf8");

  assert.match(nextToml, /\[model_providers\]\nuser = \{ name = "User provider"/);
  assert.match(nextToml, /# >>> CodexBridge managed config/);
});

test("explicit first install preserves non-conflicting top-level, comments, plugins, and MCP bytes exactly", () => {
  const original = Buffer.from([
    '# user config',
    'user_notice = "preserve exactly"',
    '',
    '[plugins.keep]',
    'enabled = true # preserve',
    '',
    '[mcp_servers.keep]',
    'command = "keep"',
    '',
  ].join("\r\n"), "utf8");
  const spec = validDraftSpec({
    codexConfig: {
      ...validDraftSpec().codexConfig,
      currentBytes: original,
    },
    allowManagedBlockInsert: true,
  });

  const codexEntry = materializeConfigMutationEntries(
    buildConfigMutationDraft(spec),
  ).find(({ id }) => id === "codexConfig");
  const expectedBlock = Buffer.from(
    managedBlock({
      catalogPath: spec.codexCatalog.target.replaceAll("\\", "/"),
    }).replaceAll("\n", "\r\n"),
    "utf8",
  );

  assert.deepEqual(
    codexEntry.content,
    Buffer.concat([expectedBlock, Buffer.from("\r\n\r\n", "utf8"), original]),
  );
});

test("selection-only drafts allow no source and can skip TOML while retaining the Codex catalog", () => {
  let managedBlockBuilds = 0;
  const spec = validDraftSpec({
    sources: [],
    includeCodexConfig: false,
    allowManagedBlockInsert: false,
    buildManagedCodexBlock() {
      managedBlockBuilds += 1;
      return managedBlock();
    },
  });

  const draft = buildConfigMutationDraft(spec);
  assert.equal(validateConfigMutationDraft(draft), true);
  assert.deepEqual(
    draft.candidates.map(({ id }) => id),
    ["selection", "options", "routerConfig", "rootCatalog", "codexCatalog"],
  );
  assert.equal(managedBlockBuilds, 0);
  const entries = materializeConfigMutationEntries(draft);
  assert.equal(entries.some(({ id }) => id === "codexConfig"), false);
});

test("malformed managed markers fail closed even when the caller skips the Codex candidate", () => {
  const malformed = [
    `${CODEXBRIDGE_MANAGED_TOML_START}\nmissing end\n`,
    `${CODEXBRIDGE_MANAGED_TOML_START}\n${CODEXBRIDGE_MANAGED_TOML_START}\n${CODEXBRIDGE_MANAGED_TOML_END}\n`,
  ];
  for (const current of malformed) {
    const spec = validDraftSpec({
      sources: [],
      includeCodexConfig: false,
      codexConfig: {
        ...validDraftSpec().codexConfig,
        currentBytes: Buffer.from(current),
      },
    });
    assert.throws(
      () => buildConfigMutationDraft(spec),
      (error) => error?.code === "config_draft_toml_invalid",
    );
  }
});

test("a managed TOML model may remain any valid Bridge route instead of being reset to the Router default", () => {
  const spec = validDraftSpec({
    buildManagedCodexBlock() {
      return managedBlock({
        model: "cb-route-b",
        catalogPath: validDraftSpec().codexCatalog.target.replaceAll("\\", "/"),
      });
    },
  });

  const draft = buildConfigMutationDraft(spec);
  assert.equal(validateConfigMutationDraft(draft), true);
  assert.match(
    materializeConfigMutationEntries(draft)
      .find(({ id }) => id === "codexConfig")
      .content.toString("utf8"),
    /^model = "cb-route-b"$/m,
  );
});

test("materialized coordinator validators reject candidate tampering and validate the complete set", async () => {
  const draft = buildConfigMutationDraft(validDraftSpec());
  const entries = materializeConfigMutationEntries(draft);
  const contexts = entries.map((entry) => ({
    id: entry.id,
    target: entry.target,
    content: entry.content,
  }));

  for (const entry of entries) {
    await entry.validate({ id: entry.id, content: entry.content, entries: contexts });
  }

  const tampered = materializeConfigMutationEntries(draft);
  tampered[3].content = Buffer.from(tampered[3].content.toString("utf8").replace("hybrid", "all_api"));
  const tamperedContexts = tampered.map((entry) => ({
    id: entry.id,
    target: entry.target,
    content: entry.content,
  }));
  await assert.rejects(
    tampered.at(-1).validate({
      id: tampered.at(-1).id,
      content: tampered.at(-1).content,
      entries: tamperedContexts,
    }),
    (error) => error?.code === "config_draft_candidate_mismatch",
  );
});

test("whole-draft validation rejects cross-file route disagreement without leaking source secrets", () => {
  const spec = validDraftSpec({
    buildCodexCatalog() {
      return { models: [{ slug: "cb-wrong-route" }] };
    },
  });

  assert.throws(
    () => buildConfigMutationDraft(spec),
    (error) => {
      assert.equal(error.code, "config_draft_inconsistent");
      assert.doesNotMatch(safeErrorSnapshot(error), new RegExp(SECRET));
      assert.equal("cause" in error, false);
      return true;
    },
  );
});

test("whole-draft validation rejects root and Codex catalogs with matching IDs but different metadata", () => {
  const spec = validDraftSpec({
    buildCodexCatalog({ routerConfig }) {
      return {
        models: routerConfig.models.map(({ id }) => ({ slug: id, source: "codex-only" })),
      };
    },
  });

  assert.throws(
    () => buildConfigMutationDraft(spec),
    (error) => error?.code === "config_draft_inconsistent",
  );
});

test("whole-draft validation enforces the hybrid managed provider contract", () => {
  const mutations = [
    (block) => block.replace('model_provider = "openai"', 'model_provider = "other"'),
    (block) => block.replace(
      'openai_base_url = "http://127.0.0.1:15722/v1"',
      'openai_base_url = "https://remote.invalid/v1"',
    ),
    (block) => block.replace("127.0.0.1:15722", "127.0.0.1:15723"),
    (block) => block.replace('openai_base_url = "http://127.0.0.1:15722/v1"\n', ""),
    (block) => block.replace(
      CODEXBRIDGE_MANAGED_TOML_END,
      'model_providers.codexbridge.base_url = "http://127.0.0.1:15722/v1"\n' +
      `model_providers.codexbridge.http_headers = { Authorization = "Bearer ${SECRET}" }\n${CODEXBRIDGE_MANAGED_TOML_END}`,
    ),
  ];

  for (const mutate of mutations) {
    const spec = validDraftSpec({
      buildManagedCodexBlock({ routerConfig }) {
        return mutate(managedBlock({
          model: routerConfig.defaultModel,
          catalogPath: validDraftSpec().codexCatalog.target.replaceAll("\\", "/"),
          mode: routerConfig.mode,
          port: routerConfig.port,
        }));
      },
    });
    assert.throws(
      () => buildConfigMutationDraft(spec),
      (error) => {
        assert.equal(error?.code, "config_draft_inconsistent");
        assert.doesNotMatch(safeErrorSnapshot(error), new RegExp(SECRET));
        assert.equal("cause" in error, false);
        return true;
      },
    );
  }
});

test("whole-draft validation requires the fixed local Authorization header only in all_api mode", () => {
  assert.equal(validateConfigMutationDraft(buildConfigMutationDraft(validDraftSpec({ mode: "all_api" }))), true);

  const mutations = [
    (block) => block.replace("requires_openai_auth = false", "requires_openai_auth = true"),
    (block) => block.replace(
      'model_providers.codexbridge.http_headers = { Authorization = "Bearer sk-local-codex-router" }\n',
      "",
    ),
    (block) => block.replace("Bearer sk-local-codex-router", `Bearer ${SECRET}`),
  ];
  for (const mutate of mutations) {
    const spec = validDraftSpec({
      mode: "all_api",
      buildManagedCodexBlock({ routerConfig }) {
        return mutate(managedBlock({
          model: routerConfig.defaultModel,
          catalogPath: validDraftSpec().codexCatalog.target.replaceAll("\\", "/"),
          mode: routerConfig.mode,
          port: routerConfig.port,
        }));
      },
    });
    assert.throws(
      () => buildConfigMutationDraft(spec),
      (error) => {
        assert.equal(error?.code, "config_draft_inconsistent");
        assert.doesNotMatch(safeErrorSnapshot(error), new RegExp(SECRET));
        assert.equal("cause" in error, false);
        return true;
      },
    );
  }
});

test("derivation failures are fail-closed and do not expose callback messages or secret values", () => {
  const spec = validDraftSpec({
    buildRouterConfig({ sources }) {
      sources.providerOverrides.providers.providerA.apiKey = "mutated";
      throw new Error(`unsafe callback detail ${SECRET}`);
    },
  });

  assert.throws(
    () => buildConfigMutationDraft(spec),
    (error) => {
      assert.equal(error.code, "config_draft_derivation_failed");
      assert.equal(error.stage, "router");
      assert.doesNotMatch(safeErrorSnapshot(error), /unsafe callback detail/);
      assert.doesNotMatch(safeErrorSnapshot(error), new RegExp(SECRET));
      assert.equal("cause" in error, false);
      return true;
    },
  );
});

test("JSON candidates reject lossy, cyclic, and non-finite inputs before any derivation runs", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const invalidValues = [
    { bad: undefined },
    { bad: Number.NaN },
    { bad: Number.POSITIVE_INFINITY },
    { bad: 1n },
    cyclic,
  ];

  for (const value of invalidValues) {
    let derivationCalls = 0;
    const spec = validDraftSpec({
      sources: [{
        id: "invalid",
        target: "C:/Temp/invalid.json",
        value,
      }],
      buildRouterConfig() {
        derivationCalls += 1;
        return {};
      },
    });
    assert.throws(
      () => buildConfigMutationDraft(spec),
      (error) => error?.code === "config_draft_json_invalid",
    );
    assert.equal(derivationCalls, 0);
  }
});
