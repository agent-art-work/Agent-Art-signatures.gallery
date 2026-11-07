// Public JavaScript identifier only. Reporting site_tag and API credentials stay with OPS.
// This owner-reviewed binding does not authorize deployment or prove routine qualification.
export const HOME_PILOT_MODE = 'home-only-qualification-v1' as const;
// Separate release purpose; this does not qualify any broader public route.
export const HOME_MEASUREMENT_MODE = 'home-only-statistics-v1' as const;
export const HOME_PILOT_BINDING = Object.freeze({
  origin: 'https://signatures.gallery',
  publicBeaconToken: 'd8f5a374c5394e57a6e739dbce89416e',
  publicBeaconTokenSha256: 'b2c6800326322f58f759fbd3dcea266783f6b1df03fdd50c8054b8cb48990553',
});
