# Contact form (wishtune.com/contact) — changes for the CRM

The contact form stays a Netlify form. Two small additions:

## 1. Optional mobile field

Add inside the existing `<form name="contact" data-netlify="true" …>`:

```html
<label for="mobile">WhatsApp / mobile (optional)</label>
<input id="mobile" name="mobile" type="tel" autocomplete="tel" inputmode="tel" placeholder="98765 43210">
```

The field **must be named `mobile`** (`phone` also works). Netlify only stores
fields that exist in the HTML form at deploy time, so redeploy the site after
adding it.

## 2. (Optional) UTM tags on contact messages

If someone arrives from an ad and writes in without signing up, these hidden
fields let the CRM record the campaign. Add inside the form:

```html
<input type="hidden" name="utm_source">
<input type="hidden" name="utm_medium">
<input type="hidden" name="utm_campaign">
<script>
  (function () {
    var saved = {};
    try { saved = JSON.parse(sessionStorage.getItem("wt_utm") || "{}"); } catch (e) {}
    var qs = new URLSearchParams(location.search);
    ["utm_source", "utm_medium", "utm_campaign"].forEach(function (k) {
      var el = document.querySelector('form[name="contact"] input[name="' + k + '"]');
      if (el) el.value = qs.get(k) || saved[k] || "";
    });
  })();
</script>
```

## 3. Netlify outgoing webhook

Netlify → Site configuration → Forms → Form notifications → Add notification →
**Outgoing webhook**

| Setting | Value |
|---|---|
| Event to listen for | New form submission |
| URL to notify | `https://crm.wishtune.com/webhooks/contact` |
| Form | `contact` (or "Any form") |
| JWS secret token | the same value as `NETLIFY_JWS_SECRET` in the backend `.env` |

If the site has other Netlify forms, set `NETLIFY_CONTACT_FORM_NAME=contact`
(the form's `name`) in the backend `.env` so only contact messages are taken.

Field names the CRM reads: `email`, `name` (or `first_name` + `last_name`),
`mobile` / `phone`, `message`. Every other field (e.g. "I'm interested in") is
kept on the event and shown on the contact's page.
