/* Jarvis-Webseite: Kern-Animation, Einwilligung, neueste Version von GitHub, Download gegen E-Mail. Keine Daten gehen
   irgendwohin, bevor jemand aktiv zustimmt (Einwilligungs-Banner) bzw. das Formular abschickt. */
(function () {
  const CFG = window.JARVIS_SITE || {};
  const $ = (s, r = document) => r.querySelector(s);
  const CONSENT_KEY = "jarvis.consent";                       // "yes" | "no" – nur im Browser des Besuchers

  // ------------------------------------------------------------------ the core (canvas)
  const c = $("#orb");
  if (c) {
    const ctx = c.getContext("2d");
    const pts = []; const n = 700; const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) { const y = 1 - (i / (n - 1)) * 2; const r = Math.sqrt(1 - y * y); const a = ga * i; pts.push([Math.cos(a) * r, y, Math.sin(a) * r]); }
    let t = 0; let reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function size() { const s = Math.min(c.clientWidth, 440); c.width = s * devicePixelRatio; c.height = s * devicePixelRatio; }
    size(); window.addEventListener("resize", size);
    function frame() {
      const W = c.width, H = c.height, R = W * 0.36, x = W / 2, y = H / 2;
      ctx.clearRect(0, 0, W, H);
      const g = ctx.createRadialGradient(x, y, R * 0.2, x, y, R * 2.2);
      g.addColorStop(0, "rgba(70,224,255,.35)"); g.addColorStop(0.4, "rgba(47,168,255,.12)"); g.addColorStop(1, "rgba(3,10,22,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const b = ctx.createRadialGradient(x - R * .35, y - R * .4, R * .1, x, y, R);
      b.addColorStop(0, "#0E3B6E"); b.addColorStop(.7, "#061C3A"); b.addColorStop(1, "#02060E");
      ctx.fillStyle = b; ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
      const cs = Math.cos(t), sn = Math.sin(t), tc = Math.cos(.35), ts = Math.sin(.35);
      for (const [px, py, pz] of pts) {
        let X = px * cs - pz * sn, Z = px * sn + pz * cs, Y = py;
        const Y2 = Y * tc - Z * ts, Z2 = Y * ts + Z * tc; Y = Y2; Z = Z2;
        if (Z < -0.15) continue;
        const d = (Z + .15) / 1.15;
        ctx.fillStyle = d > .72 ? "#F2F7FF" : "#46E0FF"; ctx.globalAlpha = .25 + .75 * d;
        ctx.beginPath(); ctx.arc(x + X * R * .96, y + Y * R * .96, R * .028 * (.4 + d), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.strokeStyle = "rgba(242,247,255,.6)"; ctx.lineWidth = Math.max(1, R * .02);
      ctx.beginPath(); ctx.ellipse(x, y, R * 1.02, R * .22, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "rgba(70,224,255,.25)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, R * 1.3, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "rgba(70,224,255,.12)"; ctx.beginPath(); ctx.arc(x, y, R * 1.6, 0, Math.PI * 2); ctx.stroke();
      t += reduced ? 0 : 0.0015;                                        // a calm, barely visible turn
      requestAnimationFrame(frame);
    }
    frame();
  }

  // ------------------------------------------------------------------ reveal on scroll
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: .12 });
    document.querySelectorAll(".reveal").forEach(el => io.observe(el));
  } else document.querySelectorAll(".reveal").forEach(el => el.classList.add("in"));

  // ------------------------------------------------------------------ consent
  function consent() { try { return localStorage.getItem(CONSENT_KEY); } catch (e) { return null; } }
  function setConsent(v) { try { localStorage.setItem(CONSENT_KEY, v); } catch (e) { } }
  const banner = $("#consent");
  if (banner && !consent()) banner.classList.add("on");
  $("#consent-yes")?.addEventListener("click", () => { setConsent("yes"); banner.classList.remove("on"); loadLatest(); });
  $("#consent-no")?.addEventListener("click", () => { setConsent("no"); banner.classList.remove("on"); });
  $("#consent-open")?.addEventListener("click", e => { e.preventDefault(); banner.classList.add("on"); });

  // ------------------------------------------------------------------ latest version (GitHub Releases API, only with consent)
  const versionEl = $("#version"), notesEl = $("#notes"), dl = $("#download-link"), dlPc = $("#download-pc"), dlAll = $("#releases-link");
  const repoUrl = `https://github.com/${CFG.repo}/releases`;
  // the files always have the same names, so the buttons work without asking anyone (no API call, no consent needed)
  if (dlAll) dlAll.href = repoUrl;
  if (dl) dl.href = `${repoUrl}/latest/download/${CFG.apkName || "Jarvis.apk"}`;
  if (dlPc) dlPc.href = `${repoUrl}/latest/download/${CFG.setupName || "Jarvis-Setup.exe"}`;
  async function loadLatest() {
    if (!versionEl || consent() !== "yes") return;
    try {
      const r = await fetch(`https://api.github.com/repos/${CFG.repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      const apk = (j.assets || []).find(a => /\.apk$/i.test(a.name));
      const setup = (j.assets || []).find(a => /\.exe$/i.test(a.name));
      const when = j.published_at ? new Date(j.published_at).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" }) : "";
      const pcv = /PC-Version:\s*v?([0-9][0-9.]*[0-9])/i.exec(j.body || "");
      versionEl.textContent = `Aktuelle Version: Android ${j.tag_name || j.name}${pcv ? " · PC " + pcv[1] : ""}${when ? " · " + when : ""}${apk ? " · APK " + Math.round(apk.size / 1048576) + " MB" : ""}${setup ? " · Setup " + Math.round(setup.size / 1048576) + " MB" : ""}`;
      if (apk && dl) dl.href = apk.browser_download_url;
      if (setup && dlPc) dlPc.href = setup.browser_download_url;
      // the release notes, as plain text (never as HTML), shortened
      const body = String(j.body || "").replace(/\r/g, "").replace(/^#+\s*/gm, "").replace(/^[-*]\s+/gm, "• ").replace(/\n{3,}/g, "\n\n").trim();
      if (notesEl && body) { notesEl.textContent = body.length > 600 ? body.slice(0, 600).replace(/\s+\S*$/, "") + " …" : body; notesEl.hidden = false; }
    } catch (e) {
      versionEl.textContent = "Die neueste Version findest du auf der Release-Seite.";
    }
  }
  if (consent() === "yes") loadLatest();
  else if (versionEl) versionEl.textContent = "Versionsnummer wird nach deiner Einwilligung von GitHub geladen.";

  // ------------------------------------------------------------------ download against e-mail
  const form = $("#dl-form"), ready = $("#dl-ready"), err = $("#dl-error");
  if (form) {
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const email = $("#email").value.trim();
      const ok = $("#optin")?.checked;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = "Bitte eine gültige E-Mail-Adresse eingeben."; $("#email").focus(); return; }
      if (CFG.brevoFormUrl && !ok) { err.textContent = "Bitte bestätige, dass wir dir Update-Mails schicken dürfen."; return; }
      err.textContent = "";
      const btn = $("#dl-submit"); btn.disabled = true; btn.textContent = "Einen Moment …";
      if (CFG.brevoFormUrl) {
        try {
          const fd = new FormData(); fd.append("EMAIL", email); fd.append("OPT_IN", "1"); fd.append("email_address_check", ""); fd.append("locale", "de");
          await fetch(CFG.brevoFormUrl, { method: "POST", mode: "no-cors", body: fd });
        } catch (e) { /* the download still works – the list is a bonus */ }
      }
      form.style.display = "none"; ready.classList.add("on");
      try { sessionStorage.setItem("jarvis.dl", "1"); } catch (e) { }
    });
    try { if (sessionStorage.getItem("jarvis.dl") === "1") { form.style.display = "none"; ready.classList.add("on"); } } catch (e) { }
  }

  // ------------------------------------------------------------------ social
  const ig = $("#instagram");
  if (ig) { if (CFG.instagram) { ig.href = "https://instagram.com/" + CFG.instagram.replace(/^@/, ""); ig.textContent = "Instagram"; } else ig.remove(); }
  document.querySelectorAll(".year").forEach(el => el.textContent = new Date().getFullYear());
})();
