import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { supabaseConfig } from './lib/supabase/config';

const PUBLIC_PATHS = ['/login', '/signup', '/auth'];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { url, key } = supabaseConfig();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  // getUser() validates the token with Supabase; getSession() alone would trust the cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
  if (!user && !isPublic) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = '';
    login.searchParams.set('next', path + request.nextUrl.search);
    const redirect = NextResponse.redirect(login);
    // The next param can carry a Shopify OAuth query; never let it leak through the Referer header.
    redirect.headers.set('Referrer-Policy', 'no-referrer');
    return redirect;
  }
  if (user && (path === '/login' || path === '/signup')) {
    const home = request.nextUrl.clone();
    home.pathname = '/dashboard';
    home.search = '';
    return NextResponse.redirect(home);
  }
  return response;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
