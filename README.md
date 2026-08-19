# Mailgraph / EmailFinder

Live domain → people finder. LinkedIn org structure first, then fill from
TheOrg, Voyager, Decodo SERP, and Hunter’s public email-finder trial.

## Stack

- TanStack Start + React
- Live sources: LinkedIn Voyager (cookie), LinkedIn guest, TheOrg SSR, Decodo Fast Search, Hunter trial
- Departments: official LinkedIn Recruiter 26 job functions

## Setup

```bash
npm install
cp .env.example .env
# fill LI_AT, LI_JSESSIONID, DECODO_BASIC_AUTH, CAPTCHAAI_KEY, OKK_PROXY_CONFIG_URL
npm run dev
```

App listens on `0.0.0.0:8080`.

## Env

| Variable | Used for |
|---|---|
| `LI_AT` / `LI_JSESSIONID` | LinkedIn Voyager people + company staffCount |
| `DECODO_BASIC_AUTH` | Google SERP shards (`Basic …`) |
| `CAPTCHAAI_KEY` | Hunter trial Turnstile |
| `OKK_PROXY_CONFIG_URL` | Residential/ISP proxy config |
| `HUNTER_API_KEY` / `PDL_API_KEY` / `THEORG_API_KEY` | Optional paid/trial APIs |

Do not commit cookies, proxy URLs, or API keys.
