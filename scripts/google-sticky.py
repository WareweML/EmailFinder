#!/usr/bin/env python3
"""Same Okk sticky IP for sorry + CaptchaAI + search GET. Prints JSON hits."""
import json, os, re, sys, time
from urllib.parse import quote

from curl_cffi import requests

KEY = os.environ.get("CAPTCHAAI_KEY", "7b42743238bb1240edf9b7bc4110a973")
HOST = os.environ.get("OKK_HOST", "49.51.189.254:9999")
PASS = os.environ.get("OKK_PASS", "Y17865319723082")
BASE = os.environ.get("OKK_USER", "td-customer-Y17865319723082-country-us")
MINS = os.environ.get("OKK_STICKY_MINUTES", "30")


def sticky_user():
    sid = os.environ.get("OKK_SESSION") or f"mg{int(time.time())}"
    return f"{BASE}-session-{sid}-sessiontime-{MINS}"


def people(html: str, company: str):
    brand = re.escape(company)
    out, seen = [], set()
    for m in re.finditer(
        r"linkedin\.com/in/([a-zA-Z0-9_%\-]+)", html, re.I
    ):
        slug = __import__("urllib.parse").parse.unquote(m.group(1))
        if slug in seen:
            continue
        seen.add(slug)
        parts = [p for p in slug.split("-") if p and not p.isdigit() and len(p) > 1]
        if len(parts) < 2:
            continue
        cap = lambda s: s[0].upper() + s[1:]
        out.append(
            {
                "name": f"{cap(parts[0])} {cap(parts[1])}",
                "slug": slug,
                "url": f"https://www.linkedin.com/in/{slug}/",
            }
        )
    return out


def main():
    query = sys.argv[1] if len(sys.argv) > 1 else 'site:linkedin.com/in GHD'
    company = sys.argv[2] if len(sys.argv) > 2 else "GHD"
    user = sticky_user()
    proxy = f"http://{user}:{PASS}@{HOST}"
    proxies = {"http": proxy, "https": proxy}
    s = requests.Session(impersonate="chrome131")
    search = "https://www.google.com/search?q=" + quote(query) + "&gbv=1&hl=en&num=10"
    r = s.get(search, proxies=proxies, timeout=20, allow_redirects=True)
    html = r.text
    if "data-sitekey" in html:
        sitekey = re.search(r'data-sitekey="([^"]+)"', html).group(1)
        datas_m = re.search(r'data-s="([^"]+)"', html)
        qval_m = re.search(r"name='q' value='([^']+)'", html) or re.search(
            r'name="q" value="([^"]+)"', html
        )
        cont_m = re.search(r'name="continue" value="([^"]+)"', html)
        payload = {
            "key": KEY,
            "method": "userrecaptcha",
            "googlekey": sitekey,
            "pageurl": str(r.url),
            "enterprise": "1",
            "json": "1",
        }
        if datas_m:
            payload["data-s"] = datas_m.group(1)
        sub = requests.post("https://ocr.captchaai.com/in.php", data=payload, timeout=30)
        js = sub.json()
        token = ua = None
        if js.get("status") == 1:
            tid = js["request"]
            for _ in range(24):
                time.sleep(5)
                pj = requests.get(
                    "https://ocr.captchaai.com/res.php",
                    params={"key": KEY, "action": "get", "id": tid, "json": 1},
                    timeout=20,
                ).json()
                tok = pj.get("result") or pj.get("request")
                if (
                    pj.get("status") == 1
                    and tok
                    and tok != "CAPCHA_NOT_READY"
                    and not str(tok).startswith("ERROR")
                ):
                    token, ua = tok, pj.get("user_agent")
                    break
        if token and qval_m:
            r = s.post(
                "https://www.google.com/sorry/index",
                data={
                    "q": qval_m.group(1),
                    "continue": cont_m.group(1).replace("&", "&")
                    if cont_m
                    else search,
                    "g-recaptcha-response": token,
                },
                proxies=proxies,
                timeout=25,
                allow_redirects=True,
                headers={"User-Agent": ua} if ua else None,
            )
            html = r.text
            if "linkedin.com/in/" not in html:
                r = s.get(
                    search,
                    proxies=proxies,
                    timeout=20,
                    allow_redirects=True,
                    headers={"User-Agent": ua} if ua else None,
                )
                html = r.text
    print(json.dumps(people(html, company)))


if __name__ == "__main__":
    main()
