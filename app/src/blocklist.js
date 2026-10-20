'use strict';
// Compact built-in list of well-known advertising / tracking / telemetry domains.
// Subdomains are matched automatically. Add your own in Settings → Privacy → Custom blocklist.
const DOMAINS = `
doubleclick.net googlesyndication.com googleadservices.com google-analytics.com googletagmanager.com googletagservices.com
adservice.google.com pagead2.googlesyndication.com 2mdn.net admob.com adsense.com adnxs.com adsrvr.org adform.net
advertising.com amazon-adsystem.com criteo.com criteo.net taboola.com outbrain.com revcontent.com mgid.com
scorecardresearch.com quantserve.com quantcast.com chartbeat.com chartbeat.net hotjar.com hotjar.io mouseflow.com
fullstory.com crazyegg.com luckyorange.com inspectlet.com clarity.ms bat.bing.com mixpanel.com segment.io segment.com
amplitude.com heap.io heapanalytics.com kissmetrics.com optimizely.com newrelic.com nr-data.net bugsnag.com
facebook.net connect.facebook.net pixel.facebook.com an.facebook.com analytics.twitter.com ads-twitter.com ads.linkedin.com
snap.licdn.com px.ads.linkedin.com analytics.tiktok.com ads.tiktok.com business-api.tiktok.com ads.pinterest.com
log.pinterest.com trk.pinterest.com ads.yahoo.com adtech.com advertising.yahoo.com analytics.yahoo.com
rubiconproject.com pubmatic.com openx.net openx.com smartadserver.com indexww.com casalemedia.com sovrn.com sharethrough.com
33across.com lijit.com triplelift.com yieldmo.com media.net teads.tv teads.com adroll.com perfectaudience.com
bidswitch.net bidr.io contextweb.com districtm.io gumgum.com improvedigital.com inmobi.com mopub.com moatads.com
adsafeprotected.com doubleverify.com integral-ads.com serving-sys.com sizmek.com flashtalking.com innovid.com
tapad.com bluekai.com krxd.net exelator.com demdex.net everesttech.net omtrdc.net 2o7.net adobedtm.com
rlcdn.com liveramp.com agkn.com mathtag.com turn.com eyeota.net lotame.com crwdcntrl.net id5-sync.com
mc.yandex.ru an.yandex.ru adfox.ru appsflyer.com adjust.com branch.io kochava.com singular.net
onesignal.com pushwoosh.com pushcrew.com sendpulse.com notix.io propellerads.com popads.net popcash.net adcash.com
exoclick.com juicyads.com trafficjunky.net clickadu.com hilltopads.net adsterra.com a-ads.com coinhive.com
ads.reddit.com events.reddit.com pixel.reddit.com
telemetry.mozilla.org stats.wp.com pixel.wp.com sb.scorecardresearch.com b.scorecardresearch.com
track.hubspot.com js.hs-analytics.net hs-analytics.net hsadspixel.net hs-banner.com
tags.tiqcdn.com tealiumiq.com ensighten.com cdn.mxpnl.com api.mixpanel.com
zedo.com adition.com adspirit.de emetriq.de ioam.de de.ioam.de ivwbox.de sensic.net
`.split(/\s+/).filter(Boolean);

module.exports = { BUILTIN: DOMAINS };
