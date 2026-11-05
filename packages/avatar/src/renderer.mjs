// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

// SVG geometry and colors adapted from the supplied ORK Avatar Studio 2.0.
// Only the original Soft 3D (clay) rendering is retained.

export function renderSoft3d(c, id) {
  const col = c.color,
    light = mix(col, "#FFFFFF", 0.37),
    dark = mix(col, "#0C6951", 0.28),
    shadow = mix(col, "#071911", 0.46);
  const d = shapes[c.shape];
  const bgColor = { night: "#0F1415", light: "#F3F5F4", mint: "#D8F8E4" }[c.background];
  const bg = bgColor ? `<rect width="600" height="600" fill="${bgColor}"/>` : "";
  const satPositions = [
    [136, 177, 22],
    [466, 433, 24],
    [484, 158, 17],
    [131, 431, 16],
  ];
  const satellites = satPositions
    .slice(0, c.satellites)
    .map(
      ([x, y, r], i) =>
        `<g class="ork-sat ork-sat-${i + 1}"><circle cx="${x}" cy="${y}" r="${r}" fill="url(#sat-${id})"/><circle cx="${x - r * 0.26}" cy="${y - r * 0.34}" r="${r * 0.22}" fill="#fff" fill-opacity=".27"/></g>`,
    )
    .join("");
  const shine = c.shine
    ? `<path d="M188 221 Q211 172 259 158" fill="none" stroke="#FFFFFF" stroke-opacity=".56" stroke-width="23" stroke-linecap="round"/>`
    : "";
  const cheeks = c.cheeks
    ? `<ellipse cx="199" cy="363" rx="22" ry="13" fill="#F38B9C" opacity=".45"/><ellipse cx="401" cy="363" rx="22" ry="13" fill="#F38B9C" opacity=".45"/>`
    : "";
  const css = c.animate ? animationCss(c, id) : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600" role="img" aria-label="Awatar ${esc(c.name)}" data-style="clay" id="${id}">
 <defs><linearGradient id="body-${id}" x1=".12" y1=".05" x2=".86" y2="1"><stop offset="0" stop-color="${light}"/><stop offset=".53" stop-color="${col}"/><stop offset="1" stop-color="${dark}"/></linearGradient><radialGradient id="sat-${id}" cx=".28" cy=".22" r=".9"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${col}"/></radialGradient><filter id="depth-${id}" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="15" stdDeviation="17" flood-color="${shadow}" flood-opacity=".3"/></filter><clipPath id="clip-${id}"><path d="${d}"/></clipPath></defs>
 ${css}${bg}${satellites}<g class="ork-body">${accessoryBehind(c.accessory)}<path d="${d}" fill="url(#body-${id})" filter="url(#depth-${id})"/><g clip-path="url(#clip-${id})"><ellipse cx="300" cy="528" rx="160" ry="80" fill="${dark}" opacity=".15"/>${shine}</g>${cheeks}<g class="ork-eyes">${eyeMarkup(c.eyes, c.eyeSize)}</g>${mouthMarkup(c.mouth)}${accessoryFront(c.accessory)}</g></svg>`;
}

function animationCss(c, id) {
  const dur = (5.7 - c.speed * 0.77).toFixed(2),
    amp = 7 + c.intensity * 5,
    rot = 2 + c.intensity * 2.3;
  const name = {
    float: "Float",
    bounce: "Bounce",
    wobble: "Wobble",
    pulse: "Pulse",
    dance: "Dance",
    spin: "Spin",
    none: null,
  }[c.motion];
  const key = (suffix) => `${id}-${suffix}`;
  return `<style>
 #${id} .ork-body,#${id} .ork-sat,#${id} .ork-eyes{transform-box:fill-box;transform-origin:center;}
 #${id} .ork-body{${name ? `animation:${key(name)} ${dur}s ease-in-out infinite;` : ""}}
 #${id} .ork-sat-1{animation:${key("SatA")} ${(Number(dur) * 1.15).toFixed(2)}s ease-in-out infinite;}
 #${id} .ork-sat-2{animation:${key("SatB")} ${(Number(dur) * 1.39).toFixed(2)}s ease-in-out infinite;}
 #${id} .ork-sat-3{animation:${key("SatB")} ${(Number(dur) * 1.16).toFixed(2)}s ease-in-out infinite reverse;}
 #${id} .ork-sat-4{animation:${key("SatA")} ${(Number(dur) * 1.43).toFixed(2)}s ease-in-out infinite reverse;}
 #${id} .ork-eyes{${c.blink ? `animation:${key("Blink")} 5.2s linear infinite;` : ""}}
 @keyframes ${key("Float")}{0%,100%{transform:translateY(0px) rotate(0deg)}50%{transform:translateY(-${amp}px) rotate(-1.5deg)}}
 @keyframes ${key("Bounce")}{0%,100%{transform:translateY(0) scale(1)}35%{transform:translateY(-${amp * 1.8}px) scale(.96,1.04)}55%{transform:translateY(0) scale(1.07,.93)}68%{transform:scale(1)}}
 @keyframes ${key("Wobble")}{0%,100%{transform:rotate(-${rot}deg)}50%{transform:rotate(${rot}deg)}}
 @keyframes ${key("Pulse")}{0%,100%{transform:scale(1)}50%{transform:scale(${(1 + c.intensity * 0.024).toFixed(3)})}}
 @keyframes ${key("Dance")}{0%,100%{transform:translate(0,0) rotate(0deg)}25%{transform:translate(-${amp / 1.6}px,-${amp}px) rotate(-${rot}deg)}50%{transform:translate(0,2px) rotate(0deg)}75%{transform:translate(${amp / 1.6}px,-${amp}px) rotate(${rot}deg)}}
 @keyframes ${key("Spin")}{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
 @keyframes ${key("SatA")}{0%,100%{transform:translateY(0)}50%{transform:translateY(-${amp * 0.9}px)}}
 @keyframes ${key("SatB")}{0%,100%{transform:translateX(0) translateY(0)}50%{transform:translateX(${amp * 0.7}px) translateY(${amp * 0.55}px)}}
 @keyframes ${key("Blink")}{0%,37%,39%,73%,75%,100%{transform:scaleY(1)}38%,74%{transform:scaleY(.08)}}
 @media(prefers-reduced-motion:reduce){#${id} .ork-body,#${id} .ork-sat,#${id} .ork-eyes{animation:none!important;}}
 </style>`;
}

const shapes = {
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
};
function safeHex(h) {
  return /^#[a-fA-F0-9]{6}$/.test(h || "") ? h.toUpperCase() : "#65E6A0";
}
function mix(a, b, amount) {
  const A = safeHex(a).slice(1),
    B = safeHex(b).slice(1);
  return (
    "#" +
    [0, 2, 4]
      .map((i) =>
        Math.round(
          parseInt(A.slice(i, i + 2), 16) * (1 - amount) + parseInt(B.slice(i, i + 2), 16) * amount,
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase()
  );
}
function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
function eyeMarkup(type, size) {
  const scl = size / 100;
  const eyes = [244, 356],
    cy = 302;
  return eyes
    .map((x, index) => {
      if (type === "sleepy" || (type === "wink" && index === 0))
        return `<path d="M ${x - 20 * scl} ${cy + 7} Q ${x} ${cy - 14 * scl} ${x + 20 * scl} ${cy + 7}" fill="none" stroke="#172127" stroke-width="${11 * scl}" stroke-linecap="round"/>`;
      if (type === "spark")
        return `<path d="M${x} ${cy - 21 * scl} Q${x + 5 * scl} ${cy - 4 * scl} ${x + 16 * scl} ${cy} Q${x + 4 * scl} ${cy + 5 * scl} ${x} ${cy + 20 * scl} Q${x - 4 * scl} ${cy + 5 * scl} ${x - 16 * scl} ${cy} Q${x - 5 * scl} ${cy - 4 * scl} ${x} ${cy - 21 * scl}Z" fill="#172127"/>`;
      if (type === "heart")
        return `<path d="M${x} ${cy + 18 * scl} C${x - 35 * scl} ${cy - 4 * scl} ${x - 11 * scl} ${cy - 24 * scl} ${x} ${cy - 10 * scl} C${x + 11 * scl} ${cy - 24 * scl} ${x + 35 * scl} ${cy - 4 * scl} ${x} ${cy + 18 * scl}Z" fill="#172127"/>`;
      if (type === "robot")
        return `<rect x="${x - 15 * scl}" y="${cy - 15 * scl}" width="${30 * scl}" height="${30 * scl}" rx="3" fill="#172127"/>`;
      if (type === "dots") return `<circle cx="${x}" cy="${cy}" r="${10 * scl}" fill="#172127"/>`;
      return `<ellipse cx="${x}" cy="${cy}" rx="${15 * scl}" ry="${27 * scl}" fill="#172127"/>`;
    })
    .join("");
}
function mouthMarkup(type) {
  if (type === "happy")
    return `<path d="M266 358 Q300 343 334 358 Q335 408 300 414 Q265 407 266 358Z" fill="#182329"/><path d="M280 397 Q300 384 320 397 Q303 413 284 404Z" fill="#FA797E"/>`;
  if (type === "grin")
    return `<path d="M258 354 Q300 382 342 354 Q332 411 300 409 Q268 408 258 354Z" fill="#182329"/><path d="M268 361 Q300 375 333 361" fill="none" stroke="#FFFFFF" stroke-width="9" stroke-linecap="round"/>`;
  if (type === "sleep")
    return `<path d="M286 366 Q300 372 314 366" fill="none" stroke="#182329" stroke-width="10" stroke-linecap="round"/>`;
  if (type === "neutral")
    return `<path d="M286 367 H314" fill="none" stroke="#182329" stroke-width="11" stroke-linecap="round"/>`;
  if (type === "surprise") return `<ellipse cx="300" cy="371" rx="15" ry="21" fill="#182329"/>`;
  if (type === "cheeky")
    return `<path d="M277 360 Q299 390 325 358" fill="none" stroke="#182329" stroke-width="12" stroke-linecap="round"/><path d="M301 378 Q321 389 312 400 Q298 398 299 382" fill="#F37D8D"/>`;
  return `<path d="M278 361 Q300 384 322 361" fill="none" stroke="#182329" stroke-width="11" stroke-linecap="round"/>`;
}
function accessoryBehind(type) {
  if (type === "antenna")
    return `<path d="M299 139 L296 89" stroke="#26343A" stroke-width="13" stroke-linecap="round"/><circle cx="295" cy="78" r="22" fill="#FFD174" stroke="#26343A" stroke-width="8"/>`;
  if (type === "headphones")
    return `<path d="M144 299 C130 92 468 89 456 299" fill="none" stroke="#24343B" stroke-width="20" stroke-linecap="round"/>`;
  return "";
}
function accessoryFront(type) {
  if (type === "headphones")
    return `<rect x="116" y="281" width="43" height="78" rx="18" fill="#26373F"/><rect x="122" y="291" width="24" height="58" rx="11" fill="#ACDDD0"/><rect x="442" y="281" width="43" height="78" rx="18" fill="#26373F"/><rect x="454" y="291" width="24" height="58" rx="11" fill="#ACDDD0"/>`;
  if (type === "glasses")
    return `<rect x="202" y="266" width="78" height="74" rx="27" fill="#102127" fill-opacity=".035" stroke="#27373B" stroke-width="8"/><rect x="321" y="266" width="78" height="74" rx="27" fill="#102127" fill-opacity=".035" stroke="#27373B" stroke-width="8"/><path d="M282 286 Q301 274 320 286" fill="none" stroke="#27373B" stroke-width="8" stroke-linecap="round"/>`;
  if (type === "star")
    return `<path d="M388 176l8 18 20 2-15 13 4 20-17-10-18 10 4-20-15-13 20-2z" fill="#FFF4BB"/>`;
  if (type === "crown")
    return `<path d="M256 153l-12-40 35 16 22-40 23 40 35-16-12 40z" fill="#FFD679" stroke="#DBA84A" stroke-width="5" stroke-linejoin="round"/>`;
  if (type === "bow")
    return `<g transform="translate(388 168)"><path d="M0 0Q-43-28-43 8Q-43 35 0 11Q43 35 43 8Q43-28 0 0Z" fill="#FDC0DF" stroke="#B95B9A" stroke-width="5"/><circle cy="6" r="12" fill="#F477AC"/></g>`;
  if (type === "halo")
    return `<ellipse cx="300" cy="120" rx="105" ry="19" fill="none" stroke="#FFE5A0" stroke-width="10" opacity=".94"/>`;
  if (type === "bolt") return `<path d="M380 176l-22 33h18l-8 30 34-42h-21l8-21z" fill="#FFF0A0"/>`;
  return "";
}
