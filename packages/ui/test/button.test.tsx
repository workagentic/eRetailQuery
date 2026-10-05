import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, cn } from '../src';

describe('cn', () => {
  it('merges conflicting tailwind classes, last wins', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});

describe('Button', () => {
  it('renders a real button with its label and variant classes', () => {
    const html = renderToStaticMarkup(<Button variant="outline">Save</Button>);
    expect(html).toContain('<button');
    expect(html).toContain('Save');
    expect(html).toContain('border');
  });
  it('forwards disabled and type', () => {
    const html = renderToStaticMarkup(
      <Button disabled type="submit">
        Go
      </Button>,
    );
    expect(html).toContain('disabled');
    expect(html).toContain('type="submit"');
  });
});
