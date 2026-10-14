// Filtering: every word, any order, everywhere.
import { describe, expect, it } from 'bun:test';
import { findChannels } from '../src/core/config.js';
import { filterByWords, fold, wordsOf } from '../src/core/match.js';
import { buildIndex, searchIndex } from '../src/core/vod.js';

const ch = (name, group = 'All', chno) => ({ id: name, name, group, chno });
const list = [
  ch('US| ESPN HD', 'US Sports', 101),
  ch('ESPN 2 HD', 'US Sports', 102),
  ch('Sky Sports 1 UK', 'UK Sports', 201),
  ch('BBCOne', 'UK', 202),
  ch('Télé Québec', 'CA | Français', 301),
  ch('CNN International', 'News', 401),
];
const names = (q) => filterByWords(list, q).map((c) => c.name);

describe('filterByWords', () => {
  it('wants every word, in any order', () => {
    expect(names('espn us')).toEqual(['US| ESPN HD', 'ESPN 2 HD']); // "us" from the name or the group
    expect(names('hd espn 2')).toEqual(['ESPN 2 HD']);
    expect(names('uk sky')).toEqual(['Sky Sports 1 UK']);
    expect(names('espn fox')).toEqual([]);
  });
  it('ignores case, accents and punctuation', () => {
    expect(names('TELE quebec')).toEqual(['Télé Québec']);
    expect(names('us|espn')).toEqual(['US| ESPN HD', 'ESPN 2 HD']);
    expect(names('québec télé')).toEqual(['Télé Québec']);
    expect(names('  cnn   ')).toEqual(['CNN International']);
  });
  it('matches across a missing space either way', () => {
    expect(names('sports1')).toEqual(['Sky Sports 1 UK']);
    expect(names('bbc one')).toEqual(['BBCOne']);
  });
  it('finds a group by its name', () => {
    expect(names('news')).toEqual(['CNN International']);
  });
  it('takes a lone number as the channel number, or a number in a name', () => {
    expect(names('201')).toEqual(['Sky Sports 1 UK']);
    expect(names('2')).toEqual(['ESPN 2 HD']); // no channel 2; "2" is in one name
  });
  it('leaves the list alone with nothing typed', () => {
    expect(filterByWords(list, '')).toBe(list);
    expect(filterByWords(list, ' ,; ')).toBe(list);
  });
  it('folds the way the server does', () => {
    expect(fold('Café, SOCIETY!')).toBe('cafe society');
    expect(wordsOf(' A+  b ')).toEqual(['a', 'b']);
  });
});

describe('the CLI, TUI and MCP lookup', () => {
  it('prefers a number, then an exact name, then every word', () => {
    expect(findChannels(list, '101').map((c) => c.name)).toEqual(['US| ESPN HD']);
    expect(findChannels(list, 'espn 2 hd').map((c) => c.name)).toEqual(['ESPN 2 HD']);
    expect(findChannels(list, 'international cnn').map((c) => c.name)).toEqual(['CNN International']);
  });
});

describe('Movies & Shows search', () => {
  it('matches across a missing space too', () => {
    const ix = buildIndex(
      'movie',
      [
        { stream_id: 1, name: 'Spider-Man: No Way Home', category_id: '1' },
        { stream_id: 2, name: 'Spiderman 2', category_id: '1' },
      ],
      [],
      { server: 'http://h', username: 'u', password: 'p' },
    );
    // Both found; the one whose name starts with the word ranks first.
    expect(searchIndex(ix, 'spiderman').items.map((x) => x.name)).toEqual(['Spiderman 2', 'Spider-Man: No Way Home']);
    expect(searchIndex(ix, 'home spider').items.map((x) => x.name)).toEqual(['Spider-Man: No Way Home']);
  });
});
