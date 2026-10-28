// "PIN vergessen?" per E-Mail (Jarvis 1.0.37 / PC 1.2.8): the link in the mail leads here with the code in the address
// (?c=123456&d=handy|pc). The page only shows it – nothing is sent anywhere, nothing is stored. Firebase adds its own
// parameters (mode, oobCode, apiKey, lang); they are not needed and are dropped from the address bar right away.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const pick = (k) => {
    let v = q.get(k);
    if (!v) {
      // the code may also sit inside a nested continueUrl (other Firebase pages)
      const cont = q.get("continueUrl");
      if (cont) {
        try {
          const u = new URL(cont);
          if (u.origin === location.origin) v = u.searchParams.get(k);
        } catch (e) { /* not a link */ }
      }
    }
    return v || "";
  };
  const code = pick("c").replace(/\D/g, "");
  const device = pick("d");
  // keep the code out of the history and of anything that reads the address later
  try { history.replaceState(null, "", location.pathname + (q.get("app") === "missing" ? "?app=missing" : "")); } catch (e) { /* old browser */ }
  document.querySelectorAll(".year").forEach((el) => { el.textContent = new Date().getFullYear(); });

  if (q.get("app") === "missing") { $("noapp").hidden = false; return; }
  if (code.length !== 6) { $("none").hidden = false; return; }

  $("code").textContent = code.slice(0, 3) + " " + code.slice(3);
  $("ok").hidden = false;
  if (device === "pc") {
    $("where").textContent = "Gib ihn am PC im Sperrbildschirm von Jarvis ein (dort, wo du „PIN vergessen?“ angeklickt hast). Danach legst du eine neue PIN fest.";
  } else if (device === "handy") {
    $("where").textContent = "Gib ihn in der Jarvis-App auf deinem Handy ein – oder tippe auf den Knopf, wenn du gerade am Handy bist. Danach legst du eine neue PIN fest.";
    if (/Android/i.test(navigator.userAgent)) {
      const back = location.origin + location.pathname + "?app=missing";
      const a = $("openApp");
      a.href = "intent://pin?c=" + code + "#Intent;scheme=jarvis;package=de.warpline.jarvis;S.browser_fallback_url=" + encodeURIComponent(back) + ";end";
      a.hidden = false;
    }
  }
})();
