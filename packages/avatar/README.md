<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# @orkbot/avatar

Render a Soft 3D ork from any nonnegative integer, or save all its appearance settings in one numeric string. The SVG geometry comes from Ork Avatar Studio 2.0.

The core runs synchronously in Node.js and browsers. It uses no server, storage, or network requests and has zero runtime dependencies.

## Open the offline preview

Build the browser bundle from the repository root:

```sh
pnpm --filter @orkbot/avatar build
```

Then open `packages/avatar/preview.html` directly in a browser. The preview works offline after the build. Generated files in `dist` are ignored by Git, so a fresh clone needs this build first.

Enter a number such as `1` or `12312312312` and choose **Odtwórz** to render its ork. You can then adjust the appearance under **Parametry** and save the full configuration as a new number, ready to paste back into the preview whenever you want that ork. Download the SVG with its animation settings included.

## Use in Node.js

Use Node.js 22 or later. Import the workspace package:

```js
import {
  encodeAvatar,
  decodeAvatar,
  renderAvatar,
  avatarFromString,
} from "@orkbot/avatar";

const svg = renderAvatar("1");
const anotherSvg = renderAvatar("12312312312");

const avatarString = encodeAvatar({
  name: "Orko",
  color: "#65E6A0",
  shape: "ork",
  background: "transparent",
  animate: false,
});

const parameters = decodeAvatar(avatarString);
const restored = avatarFromString(avatarString);
```

Omitted fields take their values from `CLASSIC_PARAMETERS`. Passing the same configuration with a different key order produces the same number, and decoding it restores every parameter, including explicit `false` and `0` values.

| Function | Returns |
| --- | --- |
| `encodeAvatar(parameters = {})` | A decimal string containing the complete configuration |
| `decodeAvatar(input)` | Full parameters decoded from an encoded number or generated from a numeric seed |
| `renderAvatar(input)` | SVG markup |
| `createAvatar(parameters = {})` | `{ version, avatarString, id, parameters, svg }` |
| `avatarFromString(input)` | The same result object, rendered from the supplied number |

`decodeAvatar`, `renderAvatar`, and `avatarFromString` accept digit strings, safe nonnegative JavaScript `Number` values, and nonnegative `BigInt` values. Use strings for long numbers. An unsafe `Number` throws an error because its digits may already have lost precision before reaching the generator.

`" 0001 "`, `"1"`, `1`, and `1n` all identify the same ork because surrounding whitespace and leading zeros are removed. The core imposes no fixed seed-length limit.

Invalid input throws `ValidationError` with a `field` property. Exports also include `VERSION`, `MAX_ENCODED_AVATAR_STRING_LENGTH`, `PARAMETER_RULES`, and `CLASSIC_PARAMETERS`.

## Use in a browser

After building, load `packages/avatar/dist/ork-avatar.js` as a regular script. An HTML file in `packages/avatar` can use these relative paths, including from `file://`:

```html
<script src="./dist/ork-avatar.js"></script>
<script>
  const avatar = OrkAvatar.avatarFromString("12312312312");
  console.log(avatar.parameters);
  console.log(avatar.svg);

  const savedNumber = OrkAvatar.encodeAvatar({
    ...avatar.parameters,
    color: "#82B5FF",
    accessory: "glasses",
  });
</script>
```

The bundle exposes the same functions through `globalThis.OrkAvatar`. In a workspace project using an ES module bundler, import `@orkbot/avatar`.

Rebuild after changing the source, using the same build command above. Run the package tests from the repository root:

```sh
pnpm --filter @orkbot/avatar test
```

The test command rebuilds the browser bundle before running the offline tests. You can also run `npm test` from `packages/avatar`.

## Parameters

Only Soft 3D is supported. Its internal style value is `clay`.

| Parameter | Accepted values | Classic default |
| --- | --- | --- |
| `name` | String of 0-24 Unicode code points, valid for XML | `Orko` |
| `color` | Six-digit hex color | `#65E6A0` |
| `shape` | `ork`, `round`, `jelly`, `drop`, `cube`, `ghost`, `bean`, `flower` | `ork` |
| `eyes` | `pill`, `dots`, `sleepy`, `wink`, `spark`, `heart`, `robot` | `pill` |
| `mouth` | `smile`, `happy`, `neutral`, `surprise`, `cheeky`, `grin`, `sleep` | `smile` |
| `accessory` | `none`, `headphones`, `glasses`, `antenna`, `star`, `crown`, `bolt`, `bow`, `halo` | `none` |
| `satellites` | Integer, 0-4 | `2` |
| `eyeSize` | Integer, 80-140 percent | `100` |
| `shine` | Boolean | `true` |
| `cheeks` | Boolean | `false` |
| `background` | `night`, `light`, `mint`, `transparent` | `night` |
| `style` | `clay` | `clay` |
| `motion` | `none`, `float`, `bounce`, `wobble`, `pulse`, `dance`, `spin` | `float` |
| `speed` | Integer, 1-5 | `3` |
| `intensity` | Integer, 1-5 | `3` |
| `blink` | Boolean | `true` |
| `animate` | Boolean | `true` |

Colors are normalized to uppercase. Unknown parameter fields and invalid values are rejected.

Set `animate: false` for a still image. With animation enabled, `motion: "none"` stops the body while satellites continue moving and `blink` controls the eyes, matching the original studio. SVG animations also respect the viewer's reduced-motion preference.

## Numeric seeds and saved configurations

Every nonnegative decimal integer works as an input. For an ordinary numeric seed, the generator folds each digit into a 64-bit state using FNV-1a, then uses SplitMix64 to choose the appearance deterministically. The same number produces the same parameters and SVG in version `"2"`.

`encodeAvatar` saves the full configuration as a decimal number. The decoder recognizes a valid v2 configuration by its version marker, field values, UTF-8 name, and CRC32 checksum. If those checks fail, the whole number becomes a seed, so a shortened or edited numeric string still produces an ork.

The classic Orko configuration encodes as:

```text
697495921471626208003591940531880713577
```

The binary payload is converted to a decimal string. It contains 13-109 bytes, depending on the UTF-8 name, and the encoded result has at most 261 digits.

| Payload bytes | Contents |
| --- | --- |
| 0 | Version marker `02` |
| 1-8 | Appearance fields packed into 61 bits |
| 9 to payload length minus 5 | Name in UTF-8 |
| Final four bytes | CRC32 checksum, big-endian |

Packed fields follow the order and bit widths in `PACKED_FIELDS` in `src/generator.mjs`. The style is fixed as Soft 3D (`clay`). The checksum recognizes a complete configuration, and the encoding provides no encryption or authentication.

`avatarFromString("1")` keeps `avatarString: "1"` in its result, while `encodeAvatar(decodeAvatar("1"))` produces a longer number that saves every generated parameter and renders identical SVG. The available appearance combinations are finite, so different inputs can share an ork.

The returned `id` is `ork-` followed by the full encoded configuration, keeping SVG identifiers bounded even for very long seeds. Existing `ork1.` strings remain readable, and `avatarFromString` converts them to a v2 configuration number. Keep the v2 mapping and renderer compatible when changing the service so saved numbers retain their appearance.

## Optional local HTTP adapter

The preview and generator work independently of HTTP. After building the browser bundle, run `pnpm --filter @orkbot/avatar start` from the repository root to start [the local server](http://127.0.0.1:4319). On macOS, `packages/avatar/start.command` starts the same adapter.

The adapter binds to `127.0.0.1`. Set `PORT` to choose another port. It accepts `127.0.0.1:<port>` and `localhost:<port>` as hosts, with browser origins restricted to those HTTP addresses at the running port.

| Method | Path | Result |
| --- | --- | --- |
| GET, HEAD, POST | `/api/v1/avatars` | `{ version, avatarString, id, parameters, svg }` |
| GET, HEAD, POST | `/api/v1/avatars.svg` | SVG with `image/svg+xml` content type |
| GET, HEAD | `/api/v1/options` | Format metadata, parameter rules, and classic defaults |
| GET, HEAD | `/health` | Status and generator version `"2"` |

POST accepts `application/json` containing exactly one of `parameters` or `avatarString`. Create a configuration number with:

```sh
curl http://127.0.0.1:4319/api/v1/avatars \
  -H 'Content-Type: application/json' \
  -d '{"parameters":{"color":"#82B5FF","animate":false}}'
```

To render a number, POST `{"avatarString":"1"}` or use the single `avatarString` query parameter:

```sh
curl --get http://127.0.0.1:4319/api/v1/avatars.svg \
  --data-urlencode 'avatarString=12312312312' \
  --output ork.svg
```

Send long numbers as JSON strings because JSON has no `BigInt` type. HTTP request bodies are limited to 16 KiB and URLs to 8 KiB, independently of the core's lack of a fixed seed-length limit. Compressed bodies and PNG output are unsupported. Responses use `Cache-Control: no-store`, and avatar responses include the ID as an `ETag`.

Errors return `{"error":{"code":"...","message":"..."}}`. Validation errors also include `field`. Status codes are 400 for invalid input, 403 for disallowed hosts or origins, 404 for unknown routes, 405 for unsupported methods, 413 for oversized bodies, 414 for oversized URLs, 415 for unsupported media, and 500 for unexpected generation errors.

## License

This package is source-available under PolyForm Noncommercial 1.0.0. See [Ork licensing](../../LICENSE.md) for the license scope and commercial licensing terms.
