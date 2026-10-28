import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GUEST_MESSAGE_MAX_LENGTH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";

import { readSubmission } from "./http.ts";

const submit = (form: FormData) =>
  readSubmission.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request("http://localhost/api/guest/messages?share=share-1", {
          method: "POST",
          body: form,
        }),
      ),
    ),
  );

it.effect("keeps a JSON file a guest attaches as a file, not a form field", () =>
  Effect.gen(function* () {
    const form = new FormData();
    form.append("shareId", "share-1");
    form.append("text", "");
    form.append("file", new File(['{"a":1}'], "data.json", { type: "application/json" }));
    const submission = yield* submit(form);
    assert.deepEqual(
      submission?.uploads.map((upload) => [upload.name, upload.contentType]),
      [["data.json", "application/json"]],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("counts a line break in a multipart message as one character", () =>
  Effect.gen(function* () {
    const text = "a\n".repeat(GUEST_MESSAGE_MAX_LENGTH / 2 - 1) + "ab";
    const form = new FormData();
    form.append("shareId", "share-1");
    form.append("text", text);
    const submission = yield* submit(form);
    assert.strictEqual(submission?.fields.text, text);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
