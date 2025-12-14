import { NextRequest, NextResponse } from "next/server";
import { searchNearby, getPlaceDetails, searchByText } from "@/lib/places";
import { generateOldShopScore, findShiniseCandidates, OldShopScoreResult } from "@/lib/vertex";

export const runtime = "nodejs"; // Vertex AI Node SDK works best in Node runtime

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const lat = parseFloat(searchParams.get("lat") || "0");
  const lng = parseFloat(searchParams.get("lng") || "0");
  const radius = parseInt(searchParams.get("radius") || "1000", 10);
  
  let targetLat = lat;
  let targetLng = lng;
  const station = searchParams.get("station");
  const genre = searchParams.get("genre");

  // Geocoding if station is provided and lat/lng are missing
  if ((!targetLat || !targetLng) && station) {
    try {
      const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(station)}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
      const geoRes = await fetch(geoUrl);
      const geoData = await geoRes.json();
      
      if (geoData.results && geoData.results.length > 0) {
        targetLat = geoData.results[0].geometry.location.lat;
        targetLng = geoData.results[0].geometry.location.lng;
      } else {
        return NextResponse.json({ error: "Station not found" }, { status: 404 });
      }
    } catch (e) {
      console.error("Geocoding error:", e);
      return NextResponse.json({ error: "Geocoding failed" }, { status: 500 });
    }
  }
  
  if (!targetLat || !targetLng) {
    return NextResponse.json({ error: "Missing lat/lng or valid station" }, { status: 400 });
  }

  try {
    let places: any[] = [];
    let isAiSourced = false;

    // 1. AI Discovery (Primary Strategy)
    if (station) {
        console.log(`🤖 Starting AI Candidate Search for ${station} (Genre: ${genre || 'Any'})...`);
        const candidates = await findShiniseCandidates(station, genre || undefined);
        
        if (candidates.length > 0) {
            console.log(`✅ AI found ${candidates.length} candidates:`, candidates);
            isAiSourced = true;

            // Hydrate candidates with Google Places Data
            const hydratePromises = candidates.map(async (name) => {
                // Search specifically for this shop near the station
                const results = await searchByText(name, targetLat, targetLng, 2000); // 2km bias
                return results.length > 0 ? results[0] : null;
            });

            const hydrated = await Promise.all(hydratePromises);
            places = hydrated.filter((p) => p !== null);
            console.log(`📍 Hydrated ${places.length} places from AI candidates.`);
        } else {
            console.warn("⚠️ AI returned no candidates, falling back to legacy search.");
        }
    }

    // 2. Legacy Fallback (Secondary Strategy)
    if (places.length === 0) {
        console.log("🔍 Using Legacy Google Maps Search...");
        if (genre) {
            places = await searchByText(genre, targetLat, targetLng, radius);
        } else {
            places = await searchNearby(targetLat, targetLng, radius);
        }
    }

    if (places.length === 0) {
      return NextResponse.json({ shops: [] });
    }

    // 3. Score shops
    // If AI sourced, we trust them more, so process up to 10.
    // If legacy, keep to 5 for performance/relevance.
    const limit = isAiSourced ? 10 : 5;
    const topPlaces = places.slice(0, limit);
    const restPlaces = places.slice(limit);

    const scoredShopsPromises = topPlaces.map(async (place) => {
      // Need details (reviews) for AI scoring
      const details = await getPlaceDetails(place.id);
      
      let aiScore: OldShopScoreResult;
      
      if (details) {
        // Collect reviews text
        const reviews = details.reviews?.map((r: any) => r.text?.text).filter(Boolean) || [];
        
        aiScore = await generateOldShopScore({
          name: place.displayName.text,
          address: place.formattedAddress,
          types: place.types,
          reviews: reviews
        });
      } else {
        // Fallback if details fail
        aiScore = { score: 0, reasoning: "詳細情報取得失敗", short_summary: "-", is_shinise: false };
      }

      return {
        ...place,
        aiAnalysis: aiScore
      };
    });

    const scoredShops = await Promise.all(scoredShopsPromises);

    // 4. Combine results
    // For non-scored shops, return basic structure
    const unScoredShops = restPlaces.map(place => ({
      ...place,
      aiAnalysis: { score: 0, reasoning: "未判定", short_summary: "-", is_shinise: false }
    }));

    const allShops = [...scoredShops, ...unScoredShops];
    
    // Sort by score if available
    allShops.sort((a, b) => b.aiAnalysis.score - a.aiAnalysis.score);

    return NextResponse.json({ shops: allShops });

  } catch (error) {
    console.error("Search API Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
