// The Cumulus://ID account bar on Conjure's staff pages. Conjure keeps its own session cookie, so
// the bar (https://id.cumuluscloud.app/id/bar.js, loaded with data-signin/data-signout) only shows
// who is signed in: this asks GET /api/me and hands the answer to window.CumulusBar. Once the bar
// is showing, the page's own Sign out button steps aside (the bar's menu has Sign out).
fetch("/api/me", { headers: { accept: "application/json" } })
  .then((res) => (res.ok ? res.json() : null))
  .then((me) => {
    if (!me || me.local) return; // local mode: no sign-in, so no account bar
    const show = () => {
      window.CumulusBar.setProfile({ name: me.name, username: me.username, email: me.email });
      for (const host of document.querySelectorAll("[data-cumulus-bar]")) host.hidden = false;
      const legacy = document.getElementById("logoutForm");
      if (legacy) legacy.style.display = "none";
    };
    if (window.CumulusBar) show();
    else window.addEventListener("cumulus-id", () => window.CumulusBar && show(), { once: true });
  })
  .catch(() => {});
