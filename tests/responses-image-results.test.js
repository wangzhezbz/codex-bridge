import assert from "node:assert/strict";
import test from "node:test";

test("image result hydration leaves responses without output arrays unchanged", async () => {
  const { hydrateStreamedImageGenerationResults } = await import(
    "../src/responses-image-results.js"
  );
  const response = { id: "resp_without_output", output: null };

  assert.equal(hydrateStreamedImageGenerationResults(null, ""), null);
  assert.equal(hydrateStreamedImageGenerationResults(response, ""), response);
  assert.equal(response.output, null);
});

test("completed image events fill matching output items by item id", async () => {
  const { hydrateStreamedImageGenerationResults } = await import(
    "../src/responses-image-results.js"
  );
  const response = {
    id: "resp_image_match",
    output: [
      { id: "image_item_a", type: "image_generation_call", status: "completed" },
      {
        id: "image_item_existing",
        type: "image_generation_call",
        status: "completed",
        result: "existing-result",
        revised_prompt: "existing prompt",
      },
    ],
  };
  const stream = sseEvent("response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "image_item_a",
      type: "image_generation_call",
      status: "completed",
      result: "  final-image-a  ",
      revised_prompt: "revised prompt a",
    },
  });

  const hydrated = hydrateStreamedImageGenerationResults(response, stream);

  assert.equal(hydrated, response);
  assert.deepEqual(response.output, [
    {
      id: "image_item_a",
      type: "image_generation_call",
      status: "completed",
      result: "final-image-a",
      revised_prompt: "revised prompt a",
    },
    {
      id: "image_item_existing",
      type: "image_generation_call",
      status: "completed",
      result: "existing-result",
      revised_prompt: "existing prompt",
    },
  ]);
});

test("partial image events append the latest unmatched candidates by output index", async () => {
  const { hydrateStreamedImageGenerationResults } = await import(
    "../src/responses-image-results.js"
  );
  const response = { id: "resp_image_append", output: [] };
  const stream = [
    sseEvent("response.image_generation_call.partial_image", {
      type: "response.image_generation_call.partial_image",
      item_id: "image_item_two",
      output_index: 2,
      partial_image_index: 0,
      partial_image_b64: "image-two-old",
    }),
    sseEvent("response.image_generation_call.partial_image", {
      type: "response.image_generation_call.partial_image",
      output_index: 1,
      partial_image_index: 0,
      partial_image_b64: "image-one",
    }),
    sseEvent("response.image_generation_call.partial_image", {
      type: "response.image_generation_call.partial_image",
      item_id: "image_item_two",
      output_index: 2,
      partial_image_index: 1,
      partial_image_b64: "image-two-latest",
    }),
  ].join("");

  hydrateStreamedImageGenerationResults(response, stream);

  assert.deepEqual(response.output, [
    {
      id: "image_generation_0",
      type: "image_generation_call",
      status: "completed",
      result: "image-one",
    },
    {
      id: "image_item_two",
      type: "image_generation_call",
      status: "completed",
      result: "image-two-latest",
    },
  ]);
});

test("image result hydration ignores malformed unrelated and blank-result events", async () => {
  const { hydrateStreamedImageGenerationResults } = await import(
    "../src/responses-image-results.js"
  );
  const response = { id: "resp_image_ignore", output: [] };
  const stream = [
    "event: broken\ndata: {not-json}\n\n",
    sseEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      delta: "not an image",
    }),
    sseEvent("response.image_generation_call.partial_image", {
      type: "response.image_generation_call.partial_image",
      item_id: "blank_image",
      output_index: 0,
      partial_image_b64: "   ",
    }),
  ].join("");

  assert.equal(hydrateStreamedImageGenerationResults(response, stream), response);
  assert.deepEqual(response.output, []);
});

function sseEvent(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
