// Classifies the client that fetched a tracking pixel or followed a link.
//
// Webmail providers fetch images through their own proxies, which hides the
// reader's device: an open via GoogleImageProxy says "Gmail", nothing more.

const BOT_PATTERN =
  /bot\b|crawler|spider|preview|scanner|curl\/|wget\/|python-requests|go-http-client|okhttp|java\/|headlesschrome|barracuda|mimecast|proofpoint|forcepoint|symantec|trendmicro|safelinks/i;

export function classifyUserAgent(userAgent = "") {
  const ua = userAgent.trim();

  if (!ua) return { client: "Unknown", os: "Unknown", device: "unknown", automated: true };
  if (BOT_PATTERN.test(ua)) return { client: "Security scanner / bot", os: "Unknown", device: "unknown", automated: true };

  if (/GoogleImageProxy/i.test(ua)) return { client: "Gmail", os: "Unknown", device: "unknown", automated: false };
  if (/YahooMailProxy/i.test(ua)) return { client: "Yahoo Mail", os: "Unknown", device: "unknown", automated: false };
  // Apple Mail Privacy Protection preloads remote content with a bare UA,
  // so these opens may happen without the recipient reading the email.
  if (ua === "Mozilla/5.0") return { client: "Apple Mail (Privacy Protection)", os: "Apple", device: "unknown", automated: false };

  const os = detectOs(ua);
  const device = detectDevice(ua, os);

  if (/Microsoft Outlook|ms-office|MSOffice|Outlook-iOS|Outlook-Android/i.test(ua)) return { client: "Outlook", os, device, automated: false };
  if (/Thunderbird/i.test(ua)) return { client: "Thunderbird", os, device, automated: false };
  if (/Edg\//.test(ua)) return { client: "Edge", os, device, automated: false };
  if (/OPR\//.test(ua)) return { client: "Opera", os, device, automated: false };
  if (/Firefox\//.test(ua)) return { client: "Firefox", os, device, automated: false };
  if (/Chrome\/|CriOS\//.test(ua)) return { client: "Chrome", os, device, automated: false };
  if (/Version\/[\d.]+.*Safari\//.test(ua)) return { client: "Safari", os, device, automated: false };
  // WebKit without a browser token is the system mail app on Apple devices.
  if (/AppleWebKit/.test(ua) && (os === "macOS" || os === "iOS")) return { client: "Apple Mail", os, device, automated: false };

  return { client: "Other", os, device, automated: false };
}

function detectOs(ua) {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "macOS";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown";
}

function detectDevice(ua, os) {
  if (/iPad|Tablet/.test(ua) || (os === "Android" && !/Mobile/.test(ua))) return "tablet";
  if (/Mobile|iPhone|iPod/.test(ua) || os === "iOS" || os === "Android") return "mobile";
  if (os === "Unknown") return "unknown";
  return "desktop";
}
