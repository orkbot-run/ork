// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

// Shared geometry from the supplied ORK Avatar Studio 2.0, in its original 600-unit canvas.

export const AVATAR_BODY_PATHS = Object.freeze({
  ork: "M 222 109 Q 238 94 246 115 L 255 146 Q 259 157 272 153 Q 300 148 328 153 Q 342 158 346 146 L 355 115 Q 362 94 379 108 C 450 153 482 224 478 302 C 477 415 405 487 302 491 C 194 491 120 418 122 304 C 120 225 154 157 222 109 Z",
  round:
    "M 300 115 C 403 115 482 197 482 302 C 482 409 402 492 300 492 C 196 492 118 410 118 303 C 118 197 199 115 300 115 Z",
  jelly:
    "M 304 124 C 397 120 469 172 477 280 C 483 397 454 481 313 485 C 181 492 129 437 124 313 C 120 184 206 127 304 124 Z",
  drop: "M 293 99 Q 305 85 317 102 C 347 135 456 220 474 308 C 498 421 417 495 300 493 C 184 491 107 419 126 309 C 143 221 257 135 293 99 Z",
  cube: "M 213 125 Q 300 111 389 125 C 442 131 463 174 471 235 Q 480 306 470 389 Q 462 470 393 484 Q 304 495 208 484 C 142 475 129 435 126 384 Q 118 306 129 224 C 135 169 159 135 213 125 Z",
  ghost:
    "M300 109 C402 109 466 189 467 305 L467 445 Q441 465 419 435 Q400 410 377 443 Q355 472 330 444 Q303 414 279 443 Q255 471 231 441 Q209 411 187 438 Q155 469 132 444 L132 304 C132 186 196 109 300 109 Z",
  bean: "M 317 130 C421 116 479 184 468 283 C460 351 424 350 419 414 C412 479 345 496 264 482 C175 467 122 420 128 330 C132 230 224 144 317 130 Z",
  flower:
    "M300 115 C325 104 358 122 378 149 C418 142 451 170 458 205 C488 222 495 257 481 292 C505 328 489 369 460 389 C459 429 425 454 391 454 C365 483 335 493 303 483 C270 496 234 479 213 456 C168 458 143 429 140 393 C105 370 110 326 126 295 C105 258 121 219 148 199 C156 158 187 144 222 151 C242 120 273 104 300 115 Z",
});

export const AVATAR_SATELLITES = Object.freeze([
  Object.freeze([136, 177, 22]),
  Object.freeze([466, 433, 24]),
  Object.freeze([484, 158, 17]),
  Object.freeze([131, 431, 16]),
]);

export function eyeParts(type, size, index, ink = "#172127") {
  const scl = size / 100;
  const x = index === 0 ? 244 : 356;
  const cy = 302;
  if (type === "sleepy" || (type === "wink" && index === 0))
    return [
      {
        tag: "path",
        props: {
          d: `M ${x - 20 * scl} ${cy + 7} Q ${x} ${cy - 14 * scl} ${x + 20 * scl} ${cy + 7}`,
          fill: "none",
          stroke: ink,
          strokeWidth: 11 * scl,
          strokeLinecap: "round",
        },
      },
    ];
  if (type === "spark")
    return [
      {
        tag: "path",
        props: {
          d: `M${x} ${cy - 21 * scl} Q${x + 5 * scl} ${cy - 4 * scl} ${x + 16 * scl} ${cy} Q${x + 4 * scl} ${cy + 5 * scl} ${x} ${cy + 20 * scl} Q${x - 4 * scl} ${cy + 5 * scl} ${x - 16 * scl} ${cy} Q${x - 5 * scl} ${cy - 4 * scl} ${x} ${cy - 21 * scl}Z`,
          fill: ink,
        },
      },
    ];
  if (type === "heart")
    return [
      {
        tag: "path",
        props: {
          d: `M${x} ${cy + 18 * scl} C${x - 35 * scl} ${cy - 4 * scl} ${x - 11 * scl} ${cy - 24 * scl} ${x} ${cy - 10 * scl} C${x + 11 * scl} ${cy - 24 * scl} ${x + 35 * scl} ${cy - 4 * scl} ${x} ${cy + 18 * scl}Z`,
          fill: ink,
        },
      },
    ];
  if (type === "robot")
    return [
      {
        tag: "rect",
        props: {
          x: x - 15 * scl,
          y: cy - 15 * scl,
          width: 30 * scl,
          height: 30 * scl,
          rx: 3,
          fill: ink,
        },
      },
    ];
  if (type === "dots") return [{ tag: "circle", props: { cx: x, cy, r: 10 * scl, fill: ink } }];
  return [{ tag: "ellipse", props: { cx: x, cy, rx: 15 * scl, ry: 27 * scl, fill: ink } }];
}

export function mouthParts(type, ink = "#182329") {
  if (type === "happy")
    return [
      {
        tag: "path",
        props: { d: "M266 358 Q300 343 334 358 Q335 408 300 414 Q265 407 266 358Z", fill: ink },
      },
      { tag: "path", props: { d: "M280 397 Q300 384 320 397 Q303 413 284 404Z", fill: "#FA797E" } },
    ];
  if (type === "grin")
    return [
      {
        tag: "path",
        props: { d: "M258 354 Q300 382 342 354 Q332 411 300 409 Q268 408 258 354Z", fill: ink },
      },
      {
        tag: "path",
        props: {
          d: "M268 361 Q300 375 333 361",
          fill: "none",
          stroke: "#FFFFFF",
          strokeWidth: 9,
          strokeLinecap: "round",
        },
      },
    ];
  if (type === "sleep")
    return [
      {
        tag: "path",
        props: {
          d: "M286 366 Q300 372 314 366",
          fill: "none",
          stroke: ink,
          strokeWidth: 10,
          strokeLinecap: "round",
        },
      },
    ];
  if (type === "neutral")
    return [
      {
        tag: "path",
        props: {
          d: "M286 367 H314",
          fill: "none",
          stroke: ink,
          strokeWidth: 11,
          strokeLinecap: "round",
        },
      },
    ];
  if (type === "surprise")
    return [{ tag: "ellipse", props: { cx: 300, cy: 371, rx: 15, ry: 21, fill: ink } }];
  if (type === "cheeky")
    return [
      {
        tag: "path",
        props: {
          d: "M277 360 Q299 390 325 358",
          fill: "none",
          stroke: ink,
          strokeWidth: 12,
          strokeLinecap: "round",
        },
      },
      { tag: "path", props: { d: "M301 378 Q321 389 312 400 Q298 398 299 382", fill: "#F37D8D" } },
    ];
  return [
    {
      tag: "path",
      props: {
        d: "M278 361 Q300 384 322 361",
        fill: "none",
        stroke: ink,
        strokeWidth: 11,
        strokeLinecap: "round",
      },
    },
  ];
}

export function accessoryParts(type, layer) {
  if (layer === "behind") {
    if (type === "antenna")
      return [
        {
          tag: "path",
          props: {
            d: "M299 139 L296 89",
            stroke: "#26343A",
            strokeWidth: 13,
            strokeLinecap: "round",
          },
        },
        {
          tag: "circle",
          props: { cx: 295, cy: 78, r: 22, fill: "#FFD174", stroke: "#26343A", strokeWidth: 8 },
        },
      ];
    if (type === "headphones")
      return [
        {
          tag: "path",
          props: {
            d: "M144 299 C130 92 468 89 456 299",
            fill: "none",
            stroke: "#24343B",
            strokeWidth: 20,
            strokeLinecap: "round",
          },
        },
      ];
    return [];
  }
  if (layer !== "front") return [];
  if (type === "headphones")
    return [
      { tag: "rect", props: { x: 116, y: 281, width: 43, height: 78, rx: 18, fill: "#26373F" } },
      { tag: "rect", props: { x: 122, y: 291, width: 24, height: 58, rx: 11, fill: "#ACDDD0" } },
      { tag: "rect", props: { x: 442, y: 281, width: 43, height: 78, rx: 18, fill: "#26373F" } },
      { tag: "rect", props: { x: 454, y: 291, width: 24, height: 58, rx: 11, fill: "#ACDDD0" } },
    ];
  if (type === "glasses")
    return [
      {
        tag: "rect",
        props: {
          x: 202,
          y: 266,
          width: 78,
          height: 74,
          rx: 27,
          fill: "#102127",
          fillOpacity: 0.035,
          stroke: "#27373B",
          strokeWidth: 8,
        },
      },
      {
        tag: "rect",
        props: {
          x: 321,
          y: 266,
          width: 78,
          height: 74,
          rx: 27,
          fill: "#102127",
          fillOpacity: 0.035,
          stroke: "#27373B",
          strokeWidth: 8,
        },
      },
      {
        tag: "path",
        props: {
          d: "M282 286 Q301 274 320 286",
          fill: "none",
          stroke: "#27373B",
          strokeWidth: 8,
          strokeLinecap: "round",
        },
      },
    ];
  if (type === "star")
    return [
      {
        tag: "path",
        props: { d: "M388 176l8 18 20 2-15 13 4 20-17-10-18 10 4-20-15-13 20-2z", fill: "#FFF4BB" },
      },
    ];
  if (type === "crown")
    return [
      {
        tag: "path",
        props: {
          d: "M256 153l-12-40 35 16 22-40 23 40 35-16-12 40z",
          fill: "#FFD679",
          stroke: "#DBA84A",
          strokeWidth: 5,
          strokeLinejoin: "round",
        },
      },
    ];
  if (type === "bow")
    return [
      {
        tag: "path",
        props: {
          d: "M0 0Q-43-28-43 8Q-43 35 0 11Q43 35 43 8Q43-28 0 0Z",
          fill: "#FDC0DF",
          stroke: "#B95B9A",
          strokeWidth: 5,
          transform: "translate(388 168)",
        },
      },
      { tag: "circle", props: { cy: 6, r: 12, fill: "#F477AC", transform: "translate(388 168)" } },
    ];
  if (type === "halo")
    return [
      {
        tag: "ellipse",
        props: {
          cx: 300,
          cy: 120,
          rx: 105,
          ry: 19,
          fill: "none",
          stroke: "#FFE5A0",
          strokeWidth: 10,
          opacity: 0.94,
        },
      },
    ];
  if (type === "bolt")
    return [
      { tag: "path", props: { d: "M380 176l-22 33h18l-8 30 34-42h-21l8-21z", fill: "#FFF0A0" } },
    ];
  return [];
}

export function cheekParts() {
  return [
    { tag: "ellipse", props: { cx: 199, cy: 363, rx: 22, ry: 13, fill: "#F38B9C", opacity: 0.45 } },
    { tag: "ellipse", props: { cx: 401, cy: 363, rx: 22, ry: 13, fill: "#F38B9C", opacity: 0.45 } },
  ];
}

const PART_TAGS = new Set(["path", "ellipse", "rect", "circle"]);
const PART_PROPS = new Set([
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "width",
  "height",
  "fill",
  "fillOpacity",
  "stroke",
  "strokeOpacity",
  "strokeWidth",
  "strokeLinecap",
  "strokeLinejoin",
  "opacity",
  "transform",
]);

/** Serialize only shared vector primitives, escaping every attribute value. */
export function serializeParts(parts) {
  return parts
    .map(({ tag, props }) => {
      if (!PART_TAGS.has(tag)) throw new TypeError("Unsupported avatar primitive");
      const attributes = Object.entries(props)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => {
          if (
            !PART_PROPS.has(name) ||
            !["string", "number"].includes(typeof value) ||
            (typeof value === "number" && !Number.isFinite(value))
          ) {
            throw new TypeError("Unsupported avatar attribute");
          }
          const key = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
          const escaped = String(value).replace(
            /[&<>"']/g,
            (character) =>
              ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
          );
          return `${key}="${escaped}"`;
        })
        .join(" ");
      return `<${tag}${attributes ? ` ${attributes}` : ""}/>`;
    })
    .join("");
}
