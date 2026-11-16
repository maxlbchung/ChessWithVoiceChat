// Redirect the legacy pages.dev address to the custom domain. Matches the
// production host exactly so preview deployments and chessicles.me are untouched.
export const onRequest: PagesFunction = async ({ request, next }) => {
  const url = new URL(request.url);
  if (url.hostname === 'chess-vc.pages.dev') {
    url.hostname = 'chessicles.me';
    return Response.redirect(url.toString(), 301);
  }
  return next();
};
