/* Jarvis-Webseite: Kern-Animation, Einwilligung, neueste Version von GitHub, Download gegen E-Mail. Keine Daten gehen
   irgendwohin, bevor jemand aktiv zustimmt (Einwilligungs-Banner) bzw. das Formular abschickt. */
(function () {
  const CFG = window.JARVIS_SITE || {};
  const $ = (s, r = document) => r.querySelector(s);
  const CONSENT_KEY = "jarvis.consent";                       // "yes" | "no" – nur im Browser des Besuchers

  // ------------------------------------------------------------------ the core (canvas): flach, ohne Leuchten,
  // Farben aus dem Stylesheet (hell/dunkel wie das System)
  const c = $("#orb");
  if (c) {
    const ctx = c.getContext("2d");
    const pts = []; const n = 700; const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) { const y = 1 - (i / (n - 1)) * 2; const r = Math.sqrt(1 - y * y); const a = ga * i; pts.push([Math.cos(a) * r, y, Math.sin(a) * r]); }
    let t = 0; const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let col = {};
    function colors() {
      const cs = getComputedStyle(document.documentElement);
      const v = (k, d) => (cs.getPropertyValue(k) || "").trim() || d;
      col = { sphere: v("--orb-sphere", "#0B2547"), dot: v("--orb-dot", "#46E0FF"), hi: v("--orb-dot-hi", "#F2F7FF"), ring: v("--orb-ring", "#0957C3") };
    }
    colors();
    try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", colors); } catch (e) { /* alte Browser */ }
    function size() { const s = Math.min(c.clientWidth, 440); c.width = s * devicePixelRatio; c.height = s * devicePixelRatio; }
    size(); window.addEventListener("resize", size);
    function frame() {
      const W = c.width, H = c.height, R = W * 0.36, x = W / 2, y = H / 2;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = col.sphere; ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
      const cs = Math.cos(t), sn = Math.sin(t), tc = Math.cos(.35), ts = Math.sin(.35);
      for (const [px, py, pz] of pts) {
        let X = px * cs - pz * sn, Z = px * sn + pz * cs, Y = py;
        const Y2 = Y * tc - Z * ts, Z2 = Y * ts + Z * tc; Y = Y2; Z = Z2;
        if (Z < -0.15) continue;
        const d = (Z + .15) / 1.15;
        ctx.fillStyle = d > .72 ? col.hi : col.dot; ctx.globalAlpha = .25 + .75 * d;
        ctx.beginPath(); ctx.arc(x + X * R * .96, y + Y * R * .96, R * .028 * (.4 + d), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = .8; ctx.strokeStyle = col.ring; ctx.lineWidth = Math.max(1, R * .016);
      ctx.beginPath(); ctx.ellipse(x, y, R * 1.02, R * .22, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = .35; ctx.lineWidth = Math.max(1, R * .008);
      ctx.beginPath(); ctx.arc(x, y, R * 1.3, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
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
  // Version, Größe und Stand in den beiden Download-Kacheln: zuerst aus config.js (keine Anfrage),
  // nach Einwilligung frisch von GitHub
  const nice = d => { try { return d ? new Date(d.length === 10 ? d + "T12:00:00Z" : d).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" }) : ""; } catch (e) { return ""; } };
  function fact(id, v) { const el = $(id); if (el) el.textContent = v || "–"; }
  function showVersions(a, p, date, sizeA, sizeP) {
    fact("#v-android", a); fact("#v-pc", p);
    fact("#s-android", sizeA ? sizeA + " MB" : ""); fact("#s-pc", sizeP ? sizeP + " MB" : "");
    fact("#d-android", date); fact("#d-pc", date);
  }
  showVersions(CFG.androidVersion, CFG.pcVersion, nice(CFG.versionDate), CFG.androidSize, CFG.pcSize);

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
      showVersions(j.tag_name || j.name || CFG.androidVersion, pcv ? pcv[1] : CFG.pcVersion, nice(j.published_at) || nice(CFG.versionDate),
        apk ? Math.round(apk.size / 1048576) : CFG.androidSize, setup ? Math.round(setup.size / 1048576) : CFG.pcSize);
      if (apk && dl) dl.href = apk.browser_download_url;
      if (setup && dlPc) dlPc.href = setup.browser_download_url;
      if (apk && $("#mb-android")) $("#mb-android").href = apk.browser_download_url;
      if (setup && $("#mb-pc")) $("#mb-pc").href = setup.browser_download_url;
      // the release notes, as plain text (never as HTML), shortened
      const body = String(j.body || "").replace(/\r/g, "").replace(/^#+\s*/gm, "").replace(/^[-*]\s+/gm, "• ").replace(/\n{3,}/g, "\n\n").trim();
      if (notesEl && body) { notesEl.textContent = body.length > 600 ? body.slice(0, 600).replace(/\s+\S*$/, "") + " …" : body; notesEl.hidden = false; }
    } catch (e) {
      versionEl.textContent = "Die neueste Version findest du auf der Release-Seite.";
    }
  }
  if (consent() === "yes") loadLatest();
  else if (versionEl) versionEl.textContent = CFG.androidVersion
    ? `Aktuelle Version: Android ${CFG.androidVersion}${CFG.pcVersion ? " · PC " + CFG.pcVersion : ""}${CFG.versionDate ? " · " + nice(CFG.versionDate) : ""}`
    : "Versionsnummer wird nach deiner Einwilligung von GitHub geladen.";

  // ------------------------------------------------------------------ download against e-mail
  const form = $("#dl-form"), ready = $("#dl-ready"), err = $("#dl-error");
  function unlock() { form.style.display = "none"; ready.classList.add("on"); $("#dl-box")?.classList.add("unlocked"); }
  if (form) {
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const email = $("#email").value.trim();
      const ok = $("#optin")?.checked;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = "Bitte eine gültige E-Mail-Adresse eingeben."; $("#email").focus(); return; }
      err.textContent = "";
      const btn = $("#dl-submit"); btn.disabled = true; btn.textContent = "Einen Moment …";
      // only with the tick: the address goes to Brevo (double opt-in – Brevo mails a confirmation link first).
      // Without it the download works all the same and nothing is sent anywhere.
      let mailed = false;
      if (CFG.brevoFormUrl && ok) {
        try {
          const fd = new FormData(); fd.append("EMAIL", email); fd.append("email_address_check", ""); fd.append("locale", "de"); fd.append("html_type", "simple");
          await fetch(CFG.brevoFormUrl, { method: "POST", mode: "no-cors", body: fd });
          mailed = true;
        } catch (e) { /* the download still works – the list is a bonus */ }
      }
      const note = $("#dl-mailnote");
      if (note) note.hidden = !mailed;
      unlock();
      try { sessionStorage.setItem("jarvis.dl", "1"); } catch (e) { }
      ready.querySelector(".ready-title")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    try { if (sessionStorage.getItem("jarvis.dl") === "1") unlock(); } catch (e) { }
  }

  // ------------------------------------------------------------------ 1.0.38: confirmed subscribers are remembered
  // Who confirmed the update mails (bestaetigt.html) or comes from the button of an update mail ("?abo=1") gets the
  // newest version right at the top and the downloads open – on every visit, in this browser. Stored is only "1"
  // (localStorage "jarvis.member"), never an e-mail address. Everybody else sees the page as before.
  const MEMBER_KEY = "jarvis.member";
  const member = () => { try { return localStorage.getItem(MEMBER_KEY) === "1"; } catch (e) { return false; } };
  const setMember = on => { try { if (on) localStorage.setItem(MEMBER_KEY, "1"); else localStorage.removeItem(MEMBER_KEY); } catch (e) { } };
  try {
    const q = new URLSearchParams(location.search);
    if (q.get("abo") === "1") {
      setMember(true);
      q.delete("abo");
      history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
    }
  } catch (e) { }
  const bar = $("#member-bar");
  if (bar && member()) {
    const v = $("#mb-versions");
    if (v && CFG.androidVersion) v.textContent = `Aktuell: Android ${CFG.androidVersion} · PC ${CFG.pcVersion || "–"}${CFG.versionDate ? " · " + nice(CFG.versionDate) : ""}`;
    const a = $("#mb-android"), p = $("#mb-pc");
    if (a && dl) a.href = dl.href;
    if (p && dlPc) p.href = dlPc.href;
    bar.hidden = false;
    if (form && ready) unlock();
    $("#mb-forget")?.addEventListener("click", () => { setMember(false); bar.hidden = true; });
  }

  // ------------------------------------------------------------------ social
  const ig = $("#instagram");
  if (ig) { if (CFG.instagram) { ig.href = "https://instagram.com/" + CFG.instagram.replace(/^@/, ""); ig.textContent = "Instagram"; } else ig.remove(); }
  document.querySelectorAll(".year").forEach(el => el.textContent = new Date().getFullYear());
})();
