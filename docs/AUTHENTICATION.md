# Authentication

Every platform is optional. Configure the ones you use; the matching tools appear automatically.
The helper `scripts/get-refresh-token.mjs` runs the OAuth flow on `http://localhost:8765/callback`
for Google, Microsoft, LinkedIn and TikTok. Register that redirect URI in each app first.

## Google Ads, GA4 and Search Console

One Google user (with access to your MCC, GA4 properties and Search Console sites) covers all three.

1. In a Google Cloud project, enable the **Google Ads API**, **Google Analytics Data API**,
   **Google Analytics Admin API** and **Google Search Console API**.
2. Configure the OAuth consent screen. For a Google Workspace organisation choose **Internal**;
   with **External / Testing**, refresh tokens expire after 7 days.
3. Create an OAuth client of type **Web application** with redirect URI `http://localhost:8765/callback`.
4. Get a refresh token:
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node scripts/get-refresh-token.mjs google
   ```
   Scopes: `adwords`, `analytics.readonly`, `webmasters.readonly`.
5. Set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to your manager account (MCC) id.

### About the developer token

Google sunset Google Ads API developer tokens on **9 September 2026**. The API access level
(test, explorer, basic, standard) now belongs to the Google Cloud project that owns your OAuth
client. The header is ignored, so `GOOGLE_ADS_DEVELOPER_TOKEN` is optional and only sent when set.
See [Google's announcement](https://developers.google.com/google-ads/api/docs/api-policy/developer-token).

## Meta (Facebook and Instagram Ads)

Recommended: a **system user** in Business Manager.

1. Business settings > Users > System users > Add (admin role).
2. Assign the ad accounts (owned and client accounts shared with your business).
3. Generate a token without expiry for your app with `ads_read` (reads), `ads_management` (writes),
   `business_management`, and optionally `pages_read_engagement` and `leads_retrieval`.
4. Set `META_ACCESS_TOKEN`, and optionally `META_APP_SECRET` (enables `appsecret_proof`) and
   `META_BUSINESS_ID` (adds owned and client ad accounts to the account list).

A long-lived personal token works too, but access then depends on that person's role.

## LinkedIn Ads

Create an app with the **Advertising API** product (scopes `r_ads`, `r_ads_reporting`, `rw_ads`), then:

```bash
LINKEDIN_CLIENT_ID=... LINKEDIN_CLIENT_SECRET=... node scripts/get-refresh-token.mjs linkedin
```

Apps with programmatic refresh get a refresh token (valid one year); otherwise you get a
60-day access token for `LINKEDIN_ACCESS_TOKEN`.

## TikTok Ads

Create an app in TikTok for Business (Marketing API), then:

```bash
TIKTOK_APP_ID=... TIKTOK_APP_SECRET=... node scripts/get-refresh-token.mjs tiktok
```

The long-lived access token covers the advertisers you authorised. `TIKTOK_APP_ID` and
`TIKTOK_APP_SECRET` are needed to list those advertisers.

## Microsoft Advertising

1. Get a developer token in the Microsoft Advertising Developer Portal.
2. Register an app in Microsoft Entra ID with redirect `http://localhost:8765/callback`.
3. Run `node scripts/get-refresh-token.mjs microsoft` with `MICROSOFT_ADS_CLIENT_ID` (and the
   secret for confidential apps).
4. Set `MICROSOFT_ADS_CUSTOMER_ID` to your manager account.

Microsoft rotates refresh tokens. The server keeps the newest one in memory and, when used as a
library, reports it through the `onTokenRotated` callback so a host can persist it.
