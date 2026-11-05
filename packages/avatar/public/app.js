// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

(() => {
  const api = globalThis.OrkAvatar;
  const $ = (id) => document.getElementById(id);
  const labels = {
    name: "Nazwa",
    color: "Kolor HEX",
    shape: "Kształt",
    eyes: "Oczy",
    mouth: "Usta",
    accessory: "Dodatek",
    satellites: "Satelity",
    eyeSize: "Wielkość oczu (%)",
    shine: "Połysk",
    cheeks: "Policzki",
    background: "Tło",
    motion: "Ruch",
    speed: "Prędkość",
    intensity: "Intensywność",
    blink: "Mruganie",
    animate: "Animacja",
  };
  const valueLabels = {
    ork: "Klasyczny ORK",
    round: "Kulka",
    jelly: "Galaretka",
    drop: "Kropla",
    cube: "Miękka kostka",
    ghost: "Duszek",
    bean: "Fasolka",
    flower: "Chmurka",
    pill: "Pigułki",
    dots: "Kropki",
    sleepy: "Przymknięte",
    wink: "Mrugnięcie",
    spark: "Iskierki",
    heart: "Serduszka",
    robot: "Robot",
    smile: "Uśmiech",
    happy: "Radość",
    neutral: "Neutralne",
    surprise: "Zaskoczenie",
    cheeky: "Język",
    grin: "Szeroki uśmiech",
    sleep: "Sen",
    none: "Brak",
    headphones: "Słuchawki",
    glasses: "Okulary",
    antenna: "Antena",
    star: "Gwiazdka",
    crown: "Korona",
    bolt: "Błyskawica",
    bow: "Kokarda",
    halo: "Aureola",
    night: "Ciemne",
    light: "Jasne",
    mint: "Miętowe",
    transparent: "Przezroczyste",
    float: "Unoszenie",
    bounce: "Podskoki",
    wobble: "Kołysanie",
    pulse: "Pulsowanie",
    dance: "Taniec",
    spin: "Obrót",
  };
  let current, imageUrl;
  const controls = new Map();

  function buildControls() {
    for (const [key, rule] of Object.entries(api.PARAMETER_RULES)) {
      if (key === "style") continue;
      const field = document.createElement("div");
      field.className = "field";
      const label = document.createElement("label");
      label.htmlFor = `parameter-${key}`;
      label.textContent = labels[key];
      const input = document.createElement(rule.type === "enum" ? "select" : "input");
      input.id = label.htmlFor;
      if (rule.type === "enum")
        for (const value of rule.values) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = valueLabels[value] ?? value;
          input.append(option);
        }
      else if (rule.type === "boolean") {
        input.type = "checkbox";
        field.className += " value-boolean";
      } else if (rule.type === "integer") {
        input.type = "number";
        input.min = rule.min;
        input.max = rule.max;
        input.step = "1";
      } else {
        input.type = "text";
        if (rule.pattern) input.pattern = rule.pattern;
      }
      field.append(label, input);
      $("parameters").append(field);
      controls.set(key, { input, rule });
    }
  }

  function show(avatar) {
    current = avatar;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(new Blob([avatar.svg], { type: "image/svg+xml" }));
    $("avatar").src = imageUrl;
    $("avatar").alt = `Awatar ${avatar.parameters.name}`;
    $("name").textContent = avatar.parameters.name;
    $("avatarString").value = avatar.avatarString;
    $("config").textContent = JSON.stringify(avatar.parameters, null, 2);
    $("download").disabled = false;
    for (const [key, { input, rule }] of controls) {
      if (rule.type === "boolean") input.checked = avatar.parameters[key];
      else input.value = avatar.parameters[key];
    }
    $("error").textContent = "";
  }

  function perform(action) {
    try {
      show(action());
    } catch (error) {
      $("error").textContent = `${error.field ?? "Dane"}: ${error.message}`;
    }
  }

  $("form").addEventListener("submit", (event) => {
    event.preventDefault();
    perform(() => api.avatarFromString($("avatarString").value));
  });
  $("save").addEventListener("click", () => {
    const parameters = {};
    for (const [key, { input, rule }] of controls) {
      parameters[key] =
        rule.type === "boolean"
          ? input.checked
          : rule.type === "integer"
            ? input.valueAsNumber
            : input.value;
    }
    perform(() => api.createAvatar(parameters));
  });
  $("classic").addEventListener("click", () => perform(() => api.createAvatar()));
  $("download").addEventListener("click", () => {
    if (!current) return;
    const link = document.createElement("a");
    link.href = imageUrl;
    link.download = "ork.svg";
    link.click();
  });

  buildControls();
  perform(() => api.createAvatar());
})();
