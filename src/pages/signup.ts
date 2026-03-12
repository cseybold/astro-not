import type { APIRoute } from 'astro';
export const prerender = false;

// Setup basic cache for IP-based rate limiting (lives across rapid requests in the same isolate)
const rateLimitCache = new Map<string, number>();

// Helper to check if an email is somewhat valid
const isValidEmail = (email: any): boolean => {
    // Simple naive regex that catches most invalid structures
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return typeof email === 'string' && email.length < 255 && emailRegex.test(email);
};

// Helper to remove everything except numbers from a phone string
const normalizePhone = (phone: any): string | null => {
    if (typeof phone !== 'string') return null;
    const digitsOnly = phone.replace(/\D/g, '');
    
    // Validate roughly if it's a valid length (e.g. US 10-15 digits)
    if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
        return digitsOnly;
    }
    return null; // Reject if it's too short or impossibly long
};

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
    try {
        // --- 1. Rate Limiting (Simple In-Memory Isolate Cache) ---
        // Astro provides clientAddress out of the box
        const ip = clientAddress || 'unknown';
        const now = Date.now();
        
        // Clear old IP records to prevent memory leaks (older than 1 minute)
        for (const [key, timestamp] of rateLimitCache.entries()) {
            if (now - timestamp > 60000) rateLimitCache.delete(key);
        }

        if (rateLimitCache.has(ip)) {
            const lastReqTime = rateLimitCache.get(ip)!;
            // Allow 1 request per 10 seconds per IP
            if (now - lastReqTime < 10000) {
                return new Response(JSON.stringify({ error: "Too many requests. Please wait." }), { 
                    status: 429,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }
        rateLimitCache.set(ip, now);


        // --- 2. Parsing & Validation ---
        const body = (await request.json()) as any;
        let { email, phone } = body;

        // Clean inputs
        const cleanEmail = email && isValidEmail(email) ? email.toLowerCase().trim() : null;
        const cleanPhone = phone ? normalizePhone(phone) : null;

        // Ensure at least one valid method was provided
        if (!cleanEmail && !cleanPhone) {
            return new Response(JSON.stringify({ error: "Please provide a valid email or phone number." }), { 
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // --- 3. Extract the D1 Binding from Astro locals ---
        // @ts-ignore - The Cloudflare runtime is injected by the adapter but Typescript may not inherently know the schema
        const db = locals.runtime?.env?.signup_binding as any;

        if (!db) {
            console.error("D1 Database binding 'signup_binding' is missing from the Cloudflare runtime env.");
            return new Response(JSON.stringify({ error: "Database not configured." }), { 
                status: 500,
                headers: { 'Content-Type': 'application/json' }
             });
        }

        // --- 4. Duplicate Prevention via D1 Lookup ---
        // Build our query carefully to see if EITHER exist if both are somehow supplied
        let existingUser = null;
        if (cleanEmail && cleanPhone) {
            existingUser = await db
                .prepare("SELECT id FROM signups WHERE email = ? OR phone = ? LIMIT 1")
                .bind(cleanEmail, cleanPhone)
                .first();
        } else if (cleanEmail) {
            existingUser = await db
                .prepare("SELECT id FROM signups WHERE email = ? LIMIT 1")
                .bind(cleanEmail)
                .first();
        } else if (cleanPhone) {
            existingUser = await db
                .prepare("SELECT id FROM signups WHERE phone = ? LIMIT 1")
                .bind(cleanPhone)
                .first();
        }

        // If D1 found a match, return early with a success code so the UI doesn't break, 
        // but we save our database from constraints/duplicates
        if (existingUser) {
            return new Response(JSON.stringify({ success: true, message: "Already subscribed." }), { 
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }


        // --- 5. Database Insertion ---
        await db
            .prepare("INSERT INTO signups (email, phone) VALUES (?, ?)")
            .bind(cleanEmail, cleanPhone)
            .run();

        return new Response(JSON.stringify({ success: true, message: "Successfully signed up!" }), { 
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        // Fallback catch-all to prevent server crashes on malformed requests
        console.error("Signup Endpoint Error:", err);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
};
