// Xtream Codes ("player_api.php") client: @profullstack/stream-providers.
//
// This was the first copy of the Xtream adapter, and it now lives in the shared
// package so every site that reads these panels runs one. hdtilt keeps its own
// user agent; everything else (URLs, account, live/VOD/series, EPG, timeshift)
// is the package's, unchanged.

import { configure } from '@profullstack/stream-providers/xtream';

configure({ userAgent: 'hdtilt' });

export * from '@profullstack/stream-providers/xtream';
