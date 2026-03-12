export async function onRequestPost(context) {
  const { request, env } = context;

  const { email, phone } = await request.json();

  await env.signup_binding
    .prepare("INSERT INTO signups (email, phone) VALUES (?, ?)")
    .bind(email, phone)
    .run();

  return new Response("Saved", { status: 200 });
}
