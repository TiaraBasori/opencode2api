import { resolveDisableTools, normalizeBool } from '../src/proxy.js';

// Regression tests: docker-compose/.env document DISABLE_TOOLS, but the code
// only honored OPENCODE_DISABLE_TOOLS, so a legacy DISABLE_TOOLS=true was
// silently ignored. Note the unit default here is false; the production
// default (true) comes from index.ts passing defaultConfig as fallback.
describe('resolveDisableTools', () => {
    const CANONICAL = 'OPENCODE_DISABLE_TOOLS';
    const LEGACY = 'DISABLE_TOOLS';
    let savedCanonical;
    let savedLegacy;

    beforeEach(() => {
        savedCanonical = process.env[CANONICAL];
        savedLegacy = process.env[LEGACY];
        delete process.env[CANONICAL];
        delete process.env[LEGACY];
    });

    afterEach(() => {
        if (savedCanonical === undefined) delete process.env[CANONICAL];
        else process.env[CANONICAL] = savedCanonical;
        if (savedLegacy === undefined) delete process.env[LEGACY];
        else process.env[LEGACY] = savedLegacy;
    });

    test('defaults to the fallback when nothing is set', () => {
        expect(resolveDisableTools()).toBe(false);
        expect(resolveDisableTools({})).toBe(false);
        expect(resolveDisableTools({}, true)).toBe(true);
        expect(resolveDisableTools(null)).toBe(false);
        expect(resolveDisableTools(null, true)).toBe(true);
    });

    // Primary regression detector: legacy=true must take effect.
    // (Old code had no DISABLE_TOOLS branch, so this returned false.)
    test('honors legacy DISABLE_TOOLS=true (primary regression)', () => {
        process.env[LEGACY] = 'true';
        expect(resolveDisableTools({})).toBe(true);
    });

    test('honors legacy DISABLE_TOOLS=false', () => {
        process.env[LEGACY] = 'false';
        expect(resolveDisableTools({})).toBe(false);
    });

    test('canonical env wins over the legacy alias', () => {
        process.env[CANONICAL] = 'false';
        process.env[LEGACY] = 'true';
        expect(resolveDisableTools({})).toBe(false);
        process.env[CANONICAL] = 'true';
        process.env[LEGACY] = 'false';
        expect(resolveDisableTools({})).toBe(true);
    });

    test('explicit options win over both env vars', () => {
        process.env[CANONICAL] = 'true';
        process.env[LEGACY] = 'true';
        expect(resolveDisableTools({ DISABLE_TOOLS: false })).toBe(false);
        process.env[CANONICAL] = 'false';
        process.env[LEGACY] = 'false';
        expect(resolveDisableTools({ DISABLE_TOOLS: true })).toBe(true);
        expect(resolveDisableTools({ disableTools: true })).toBe(true);
        expect(resolveDisableTools({ DISABLE_TOOLS: 'false', disableTools: true })).toBe(false);
    });

    test('parses common bool spellings', () => {
        for (const v of ['1', 'true', 'yes', 'y', 'on', ' TRUE ']) {
            process.env[LEGACY] = v;
            expect(resolveDisableTools({})).toBe(true);
        }
        for (const v of ['0', 'false', 'no', 'n', 'off', ' FALSE ']) {
            process.env[LEGACY] = v;
            expect(resolveDisableTools({})).toBe(false);
        }
    });

    // Invalid values mean "unset" and fall through; they must NOT coerce.
    test('invalid values fall through to the next source', () => {
        for (const garbage of ['garbage', '', '   ', '2', 'truthy']) {
            process.env[CANONICAL] = garbage;
            process.env[LEGACY] = 'true';
            expect(resolveDisableTools({})).toBe(true);
            process.env[LEGACY] = 'false';
            expect(resolveDisableTools({})).toBe(false);
            delete process.env[LEGACY];
            expect(resolveDisableTools({})).toBe(false);
            expect(resolveDisableTools({}, true)).toBe(true);
        }
        // Legacy layer alone with garbage also falls back (not coerced).
        for (const garbage of ['garbage', '', '   ']) {
            process.env[LEGACY] = garbage;
            expect(resolveDisableTools({})).toBe(false);
            expect(resolveDisableTools({}, true)).toBe(true);
        }
        // Invalid option values fall through to env as well.
        process.env[CANONICAL] = 'true';
        for (const garbage of ['garbage', '', '   ']) {
            expect(resolveDisableTools({ DISABLE_TOOLS: garbage })).toBe(true);
        }
        expect(resolveDisableTools({ DISABLE_TOOLS: 'garbage', disableTools: 'false' })).toBe(false);
    });

    test('numbers 0/1 parse, other numbers fall through like invalid strings', () => {
        // 1/0 behave like '1'/'0'; any other number is "unset" and falls
        // through instead of coercing to false and blocking env.
        expect(resolveDisableTools({ DISABLE_TOOLS: 1 })).toBe(true);
        expect(resolveDisableTools({ DISABLE_TOOLS: 0 })).toBe(false);
        process.env[CANONICAL] = 'true';
        expect(resolveDisableTools({ DISABLE_TOOLS: 2 })).toBe(true);
        expect(resolveDisableTools({ DISABLE_TOOLS: -1 })).toBe(true);
        expect(resolveDisableTools({ DISABLE_TOOLS: 0 })).toBe(false);
        process.env[CANONICAL] = 'false';
        expect(resolveDisableTools({ DISABLE_TOOLS: 2 })).toBe(false);
        delete process.env[CANONICAL];
        expect(resolveDisableTools({ DISABLE_TOOLS: 2 })).toBe(false);
        expect(resolveDisableTools({ DISABLE_TOOLS: 2 }, true)).toBe(true);
    });
});

// index.ts cannot be imported directly (it starts the server), so mirror its
// exact resolution call here to pin the env > file > default contract.
// index.ts calls resolveDisableTools({DISABLE_TOOLS: canonical,
// disableTools: legacy}, normalizeBool(file) ?? default).
describe('index.js DISABLE_TOOLS chain (mirrored)', () => {
    const resolveIndexChain = (env, fileConfig, defaultValue) =>
        resolveDisableTools(
            {
                DISABLE_TOOLS: env.OPENCODE_DISABLE_TOOLS,
                disableTools: env.DISABLE_TOOLS,
            },
            normalizeBool(fileConfig.DISABLE_TOOLS) ?? defaultValue,
        );

    test('env > file > default', () => {
        expect(resolveIndexChain({}, {}, true)).toBe(true);
        expect(resolveIndexChain({}, { DISABLE_TOOLS: false }, true)).toBe(false);
        expect(resolveIndexChain({ DISABLE_TOOLS: 'false' }, { DISABLE_TOOLS: true }, true)).toBe(false);
        expect(resolveIndexChain({ OPENCODE_DISABLE_TOOLS: 'false' }, { DISABLE_TOOLS: true }, true)).toBe(false);
        expect(resolveIndexChain(
            { OPENCODE_DISABLE_TOOLS: 'true', DISABLE_TOOLS: 'false' },
            { DISABLE_TOOLS: false }, false,
        )).toBe(true);
    });

    test('invalid env falls through to file, not default', () => {
        expect(resolveIndexChain(
            { OPENCODE_DISABLE_TOOLS: 'garbage', DISABLE_TOOLS: '' },
            { DISABLE_TOOLS: false }, true,
        )).toBe(false);
    });
});
