/**
 * Facts the website assistant may use. Everything here is either on the
 * public website or general product knowledge. No prices, lead times or
 * warranty terms are included on purpose: those must be confirmed by staff.
 */
import { PRODUCTS } from './config.js';

export const BUSINESS = {
  name: 'S. MORI Window Fashion',
  short: 'SMORI',
  phone: '(949) 880-1322',
  phoneRaw: '9498801322',
  email: 'BonnieX@smoriwindowfashion.com',
  address: '23 Mauchly Suite 106, Irvine, CA 92618',
  hours: 'Mon–Fri 9AM–5PM; weekends by appointment',
  serviceArea: 'Southern California (Orange County and surrounding areas)',
  website: 'https://smoriwindowfashion.com',
  consultation: 'complimentary in-home consultation and measurement',
};

export const KNOWLEDGE = `
ABOUT
- ${BUSINESS.name} is a luxury window-treatment studio in Irvine, California, serving ${BUSINESS.serviceArea}.
- Showroom: ${BUSINESS.address}. Hours: ${BUSINESS.hours}. Phone ${BUSINESS.phone}. Email ${BUSINESS.email}.
- Process: (1) in-home consultation (complimentary), (2) fabric and product selection with samples, (3) precise measurement by our team, (4) custom fabrication, (5) white-glove installation by our installers.
- We carry Hunter Douglas products and make custom drapery.

PRODUCT LINES
${PRODUCTS.map((p) => `- ${p.name} (${p.subtitle}): ${p.notes}`).join('\n')}
- Plantation shutters and commercial projects (offices, showrooms, restaurants) are also available.

LIGHT CONTROL AND BLACKOUT
- Opacity levels: sheer (softens light, little privacy), light-filtering (diffuses light, daytime privacy), room-darkening (blocks most light), blackout/opaque (blocks nearly all light through the fabric; some light may still enter around the edges unless side channels or an outside mount with overlap are used).
- Best for bedrooms and media rooms: Duette honeycomb in room-darkening or blackout opacity, Designer Roller in blackout fabric, Vignette Roman shades in room-darkening fabric, or lined/blackout-lined drapery. Layering (a sheer plus a blackout layer) gives both daytime softness and night-time darkness.
- Sheer products (Silhouette, Pirouette, Luminette) are for light control and daytime privacy, not blackout. Silhouette and Pirouette are also available with a room-darkening liner option; confirm availability with staff.

PRIVACY
- Daytime privacy: sheers and light-filtering fabrics let you see out more than others see in during the day; at night with interior lights on, sheers do not provide privacy, so a second layer or a privacy-rated fabric is needed.
- Top-down/bottom-up lift (available on many shades incl. Duette, Vignette, Silhouette) lets you cover the lower part of the window for street-level privacy while keeping light from the top.
- Luminette is designed for wide windows and sliding doors and rotates vanes for adjustable privacy.

MOTORIZATION AND SMART HOME
- PowerView motorization can be added to most Hunter Douglas products. Control by remote, the PowerView app, schedules/scenes, and voice assistants (Amazon Alexa, Google Assistant, Apple HomeKit/Siri) through the PowerView hub/gateway.
- Power options: rechargeable battery wand, plug-in, or hardwired. Suitability for a specific window, existing wiring, or an existing smart-home system must be confirmed by our team during the consultation.
- Motorization is popular for high or hard-to-reach windows, homes with children (no cords), and whole-home scheduling.

CHILD SAFETY
- Cordless and motorized options remove dangling cords and are recommended for homes with children or pets.

MEASUREMENT AND INSTALLATION
- We measure and install; customers do not need to measure themselves. During the consultation we check inside vs outside mount, window depth, obstructions (handles, cranks, trim), and sun exposure.
- Rough sizes and photos from the customer are helpful for preparing the consultation, but final measurements are always taken by our team.
- Installation is done by our own installers; typical installations are completed in a single visit, but the exact schedule depends on the project and is confirmed by staff.
- We can usually take down and dispose of old treatments during installation; confirm with staff.

CARE
- Most fabrics can be dusted with a feather duster or vacuumed gently with a brush attachment; spot-clean with mild soap. Follow the care guide that comes with the product.

WHAT WE CANNOT ANSWER HERE (must be confirmed by a person)
- Prices, quotes, discounts, financing; production or delivery lead times; warranty terms and claims; product availability for a specific window; compatibility with a specific smart-home setup; anything about an existing order.
`;
