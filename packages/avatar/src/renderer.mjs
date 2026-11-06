// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

// SVG geometry and colors adapted from the supplied ORK Avatar Studio 2.0.
// Only the original Soft 3D (clay) rendering is retained.

import {
  AVATAR_BODY_PATHS,
  AVATAR_SATELLITES,
  accessoryParts,
  cheekParts,
  eyeParts,
  mouthParts,
  serializeParts,
} from "./art.mjs";

export function renderSoft3d(c, id) {
  const col = c.color,
    light = mix(col, "#FFFFFF", 0.37),
    dark = mix(col, "#0C6951", 0.28),
    shadow = mix(col, "#071911", 0.46);
  const d = AVATAR_BODY_PATHS[c.shape];
  const bgColor = { night: "#0F1415", light: "#F3F5F4", mint: "#D8F8E4" }[c.background];
  const bg = bgColor ? `<rect width="600" height="600" fill="${bgColor}"/>` : "";
  const satellites = AVATAR_SATELLITES.slice(0, c.satellites)
    .map(
      ([x, y, r], i) =>
        `<g class="ork-sat ork-sat-${i + 1}"><circle cx="${x}" cy="${y}" r="${r}" fill="url(#sat-${id})"/><circle cx="${x - r * 0.26}" cy="${y - r * 0.34}" r="${r * 0.22}" fill="#fff" fill-opacity=".27"/></g>`,
    )
    .join("");
  const shine = c.shine
    ? `<path d="M188 221 Q211 172 259 158" fill="none" stroke="#FFFFFF" stroke-opacity=".56" stroke-width="23" stroke-linecap="round"/>`
    : "";
  const cheeks = c.cheeks ? serializeParts(cheekParts()) : "";
  const css = c.animate ? animationCss(c, id) : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600" role="img" aria-label="Awatar ${esc(c.name)}" data-style="clay" id="${id}">
 <defs><linearGradient id="body-${id}" x1=".12" y1=".05" x2=".86" y2="1"><stop offset="0" stop-color="${light}"/><stop offset=".53" stop-color="${col}"/><stop offset="1" stop-color="${dark}"/></linearGradient><radialGradient id="sat-${id}" cx=".28" cy=".22" r=".9"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${col}"/></radialGradient><filter id="depth-${id}" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="15" stdDeviation="17" flood-color="${shadow}" flood-opacity=".3"/></filter><clipPath id="clip-${id}"><path d="${d}"/></clipPath></defs>
 ${css}${bg}${satellites}<g class="ork-body">${serializeParts(accessoryParts(c.accessory, "behind"))}<path d="${d}" fill="url(#body-${id})" filter="url(#depth-${id})"/><g clip-path="url(#clip-${id})"><ellipse cx="300" cy="528" rx="160" ry="80" fill="${dark}" opacity=".15"/>${shine}</g>${cheeks}<g class="ork-eyes">${serializeParts([0, 1].flatMap((index) => eyeParts(c.eyes, c.eyeSize, index)))}</g>${serializeParts(mouthParts(c.mouth))}${serializeParts(accessoryParts(c.accessory, "front"))}</g></svg>`;
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
