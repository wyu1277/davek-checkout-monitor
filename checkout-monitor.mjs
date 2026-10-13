
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = (process.env.STORE_URL || '').replace(/\/$/, '');
const PRODUCT_PATH = process.env.PRODUCT_PATH || '';
const WEBHOOK = process.env.ALERT_WEBHOOK || '';
const UPDATE = process.argv.includes('--update-baseline');

const BASELINE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'baseline.json'
);

if (!STORE || !PRODUCT_PATH) {
  console.error('Set STORE_URL and PRODUCT_PATH');
  process.exit(2);
}

let parsedStoreUrl;

try {
  parsedStoreUrl = new URL(STORE);
} catch {
  console.error(
    'STORE_URL must be a valid URL, such as https://davekny.com'
  );
  process.exit(2);
}

if (!['http:', 'https:'].includes(parsedStoreUrl.protocol)) {
  console.error('STORE_URL must use http:// or https://');
  process.exit(2);
}

if (!PRODUCT_PATH.startsWith('/')) {
  console.error(
    'PRODUCT_PATH must start with /, such as /products/the-davek-mini'
  );
  process.exit(2);
}

const STORE_HOST = parsedStoreUrl.hostname;

const ALLOWED = [
  STORE_HOST,
  'checkout.shopify.com',
  'shop.app',
  'pay.shopify.com',
  ...(process.env.ALLOWED_CHECKOUT_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean),
];

const hostOk = (hostname) =>
  ALLOWED.some(
    (allowedHost) =>
      hostname === allowedHost ||
      hostname.endsWith('.' + allowedHost)
  );

const PROFILES = {
  desktop: devices['Desktop Chrome'],
  mobile: devices['Pixel 7'],
};

const CHECKOUT_SEL =
  'button[name="checkout"], input[name="checkout"], a[href*="/checkout"]';

const ADD_SEL =
  'form[action*="/cart/add"] [type="submit"], button[name="add"]';

async function runProfile(browser, name, device) {
  const findings = [];
  const scriptHosts = new Set();
  const navs = [];
  const popups = [];

  const context = await browser.newContext({
    ...device,
    locale: 'en-US',
  });

  const page = await context.newPage();

  page.on('request', (request) => {
    if (request.resourceType() === 'script') {
      try {
        scriptHosts.add(new URL(request.url()).host);
      } catch {
        // Ignore malformed request URLs.
      }
    }
  });

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      navs.push(frame.url());
    }
  });

  context.on('page', (newPage) => {
    if (newPage !== page) {
      popups.push(newPage);
    }
  });

  let buttonTargets = [];

  try {
    // Load the product page with a search-engine referrer.
    await page.goto(STORE + PRODUCT_PATH, {
      waitUntil: 'domcontentloaded',
      referer: 'https://www.google.com/',
    });

    buttonTargets = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[name="checkout"], a[href*="/checkout"], form[action*="/cart"]'
        ),
      ].map((element) => {
        const href = element.getAttribute('href') || '';
        const action =
          element.getAttribute('action') ||
          (element.form && element.form.getAttribute('action')) ||
          element.getAttribute('formaction') ||
          '';

        return `${element.tagName}|${href}|${action}`;
      })
    );

    // Add the product to the cart.
    await page.locator(ADD_SEL).first().click({
      timeout: 15000,
    });

    await page.waitForTimeout(3000);

    // Open the cart.
    await page.goto(STORE + '/cart', {
      waitUntil: 'domcontentloaded',
    });

    const checkout = page.locator(CHECKOUT_SEL).first();

    // Record checkout-related elements on the cart page.
    buttonTargets.push(
      ...(await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '[name="checkout"], a[href*="/checkout"], form[action*="/cart"]'
          ),
        ].map((element) => {
          const href = element.getAttribute('href') || '';
          const action =
            element.getAttribute('action') ||
            (element.form && element.form.getAttribute('action')) ||
            element.getAttribute('formaction') ||
            '';

          return `${element.tagName}|${href}|${action}`;
        })
      ))
    );

    // Click checkout.
    await checkout.waitFor({
      state: 'visible',
      timeout: 15000,
    });

    await checkout.click({
      timeout: 15000,
    });

    // Selleasy may display an in-page offer before checkout.
    // Search for its decline/continue text without assuming it is a link.
    const selleasyDecline = page.getByText(
      /no thanks[\s\S]*just take me to checkout/i
    );

    let selleasyOfferDetected = false;

    try {
      await selleasyDecline.waitFor({
        state: 'visible',
        timeout: 8000,
      });

      selleasyOfferDetected = true;
    } catch (error) {
      if (error.name !== 'TimeoutError') {
        throw error;
      }
    }

    if (selleasyOfferDetected) {
      // If the offer is visible but cannot be dismissed, fail the test.
      await selleasyDecline.click({
        timeout: 5000,
      });

      console.log(`[${name}] Selleasy offer dismissed.`);
    }

    // Allow checkout navigation and delayed redirects to finish.
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForTimeout(10000);

    // Check navigations for unexpected hosts.
    const urls = new Set([
      ...navs,
      page.url(),
      ...popups.map((popup) => popup.url()),
    ]);

    for (const url of urls) {
      let hostname = '';

      try {
        hostname = new URL(url).hostname;
      } catch {
        continue;
      }

      if (!hostname) continue;

      if (!hostOk(hostname)) {
        findings.push({
          level: 'CRITICAL',
          msg: `[${name}] navigated to non-allowlisted host ${hostname} (${url})`,
        });
      }
    }

    // Flag any new browser tab or window.
    if (popups.length) {
      findings.push({
        level: 'CRITICAL',
        msg: `[${name}] popup opened during checkout: ${popups
          .map((popup) => popup.url())
          .join(', ')}`,
      });
    }

    // Require the expected Davek checkout URL.
    const finalUrl = new URL(page.url());

    const reachedExpectedCheckout =
      finalUrl.hostname === 'davekny.com' &&
      (
        finalUrl.pathname === '/checkouts' ||
        finalUrl.pathname.startsWith('/checkouts/')
      );

    if (!reachedExpectedCheckout) {
      findings.push({
        level: 'CRITICAL',
        msg: `[${name}] expected checkout at davekny.com/checkouts, but final URL was: ${finalUrl.href}`,
      });
    }
  } catch (error) {
    findings.push({
      level: 'ERROR',
      msg: `[${name}] flow failed: ${error.message.split('\n')[0]}`,
    });
  } finally {
    await context.close();
  }

  return {
    findings,
    snapshot: {
      scriptHosts: [...scriptHosts].sort(),
      buttonTargets: [...new Set(buttonTargets)].sort(),
    },
  };
}

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function diffAgainstBaseline(name, snapshot, baseline) {
  const findings = [];
  const previous = baseline?.[name];

  if (!previous) return findings;

  for (const host of snapshot.scriptHosts) {
    if (!previous.scriptHosts.includes(host)) {
      findings.push({
        level: 'WARN',
        msg: `[${name}] NEW script host not in baseline: ${host}`,
      });
    }
  }

  for (const target of snapshot.buttonTargets) {
    if (!previous.buttonTargets.includes(target)) {
      findings.push({
        level: 'WARN',
        msg: `[${name}] NEW/CHANGED checkout element target: ${target}`,
      });
    }
  }

  return findings;
}

async function sendAlert(findings) {
  const message =
    ':rotating_light: Checkout monitor on ' +
    STORE_HOST +
    '\n' +
    findings
      .map((finding) => `${finding.level}: ${finding.msg}`)
      .join('\n');

  console.error(message);

  if (WEBHOOK) {
    try {
      const response = await fetch(WEBHOOK, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          text: message,
        }),
      });

      if (!response.ok) {
        console.error(
          `Alert delivery failed: webhook returned HTTP ${response.status}`
        );
      }
    } catch (error) {
      console.error('Alert delivery failed:', error.message);
    }
  }
}

const browser = await chromium.launch({
  headless: true,
});

const baseline = loadBaseline();
const merged = baseline ? structuredClone(baseline) : {};
const allFindings = [];

try {
  for (const [name, device] of Object.entries(PROFILES)) {
    const { findings, snapshot } = await runProfile(
      browser,
      name,
      device
    );

    allFindings.push(...findings);

    if (UPDATE) {
      const previous = merged[name] || {
        scriptHosts: [],
        buttonTargets: [],
      };

      merged[name] = {
        scriptHosts: [
          ...new Set([
            ...previous.scriptHosts,
            ...snapshot.scriptHosts,
          ]),
        ].sort(),

        buttonTargets: [
          ...new Set([
            ...previous.buttonTargets,
            ...snapshot.buttonTargets,
          ]),
        ].sort(),
      };
    } else if (baseline) {
      allFindings.push(
        ...diffAgainstBaseline(name, snapshot, baseline)
      );
    }
  }
} finally {
  await browser.close();
}

if (UPDATE) {
  fs.writeFileSync(
    BASELINE_FILE,
    JSON.stringify(merged, null, 2) + '\n'
  );

  console.log(
    'Baseline updated. Review baseline.json before committing; remove anything you do not recognize.'
  );

  if (allFindings.length) {
    await sendAlert(allFindings);
    process.exit(1);
  }

  process.exit(0);
}

if (!baseline) {
  console.warn(
    'No baseline.json found; skipping script/button diff. Run with --update-baseline first.'
  );
}

if (allFindings.length) {
  await sendAlert(allFindings);
  process.exit(1);
}

console.log('OK: checkout flow clean on all profiles.');
