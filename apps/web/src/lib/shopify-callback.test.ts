import { describe, expect, it } from 'vitest';
import {
  connectionsPathFromApiRedirect,
  loginPathForCallback,
  rawQueryFromSearch,
} from './shopify-callback';

describe('rawQueryFromSearch', () => {
  it('returns the query untouched, without the leading question mark', () => {
    expect(rawQueryFromSearch('?code=a%3D&host=YQ%3D%3D&hmac=ff')).toBe(
      'code=a%3D&host=YQ%3D%3D&hmac=ff',
    );
    expect(rawQueryFromSearch('code=a&b=c')).toBe('code=a&b=c');
  });
  it('rejects empty, oversize and control-character input', () => {
    expect(rawQueryFromSearch('')).toBeNull();
    expect(rawQueryFromSearch('?')).toBeNull();
    expect(rawQueryFromSearch(`?a=${'x'.repeat(5000)}`)).toBeNull();
    expect(rawQueryFromSearch('?a=b\u0000c')).toBeNull();
    expect(rawQueryFromSearch('?a=b\nc')).toBeNull();
  });
});

describe('connectionsPathFromApiRedirect', () => {
  const base = 'http://localhost:3000';
  it('maps the known result shapes to a same-site path', () => {
    expect(connectionsPathFromApiRedirect(`${base}/connections?shopify=connected`)).toBe(
      '/connections?shopify=connected',
    );
    expect(
      connectionsPathFromApiRedirect(`${base}/connections?shopify=connected&warning=webhooks`),
    ).toBe('/connections?shopify=connected&warning=webhooks');
    expect(connectionsPathFromApiRedirect(`${base}/connections?shopify_error=wrong_account`)).toBe(
      '/connections?shopify_error=wrong_account',
    );
  });
  it('drops unknown keys and values and refuses other paths, hosts and junk', () => {
    expect(connectionsPathFromApiRedirect(`${base}/connections?shopify=connected&evil=1`)).toBe(
      '/connections?shopify=connected',
    );
    expect(
      connectionsPathFromApiRedirect(`${base}/connections?shopify_error=%3Cscript%3E`),
    ).toBeNull();
    expect(connectionsPathFromApiRedirect(`${base}/connections?shopify=nope`)).toBeNull();
    expect(connectionsPathFromApiRedirect(`${base}/elsewhere?shopify=connected`)).toBeNull();
    expect(connectionsPathFromApiRedirect('javascript:alert(1)')).toBeNull();
    expect(connectionsPathFromApiRedirect('not a url')).toBeNull();
    // host ignored, only the path and whitelisted keys survive
    expect(
      connectionsPathFromApiRedirect('https://evil.example/connections?shopify=connected'),
    ).toBe('/connections?shopify=connected');
  });
  it('prefers the error when both an error and a result are present', () => {
    expect(
      connectionsPathFromApiRedirect(
        `${base}/connections?shopify=connected&shopify_error=not_allowed`,
      ),
    ).toBe('/connections?shopify_error=not_allowed');
  });
});

describe('loginPathForCallback', () => {
  it('sends the user to login and back to the callback with the query intact', () => {
    const path = loginPathForCallback('?code=a%3D&hmac=ff');
    expect(path.startsWith('/login?next=')).toBe(true);
    expect(decodeURIComponent(path.slice('/login?next='.length))).toBe(
      '/connections/shopify/callback?code=a%3D&hmac=ff',
    );
  });
});
