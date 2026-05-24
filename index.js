const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Helper: call Anthropic ─────────────────────────────────────────────────
async function callClaude(apiKey, messages, maxTokens) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages,
    }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.type + ': ' + data.error.message);
  return data.content?.map(b => b.text || '').join('') || '';
}

// ── Main route ─────────────────────────────────────────────────────────────
app.post('/generate-report', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { type: 'configuration_error', message: 'API key not configured.' } });
  }

  try {
    // The full prompt arrives from App.tsx exactly as before
    const incomingMessages = req.body.messages;
    const fullPrompt = incomingMessages?.[0]?.content;

    if (!fullPrompt || typeof fullPrompt !== 'string') {
      return res.status(400).json({ error: { type: 'bad_request', message: 'No prompt received.' } });
    }

    // ── STAGE 1: Clinical intelligence ──────────────────────────────────────
    // Extract patterns, select modules, plan supplements, flag interactions.
    // Output is a structured clinical plan — not client-facing text.

    const stage1Prompt = `You are a functional wellness clinical analyst. Your job is to read the following client intake and produce a structured clinical plan that will be used in the next stage to write the final report.

DO NOT write the client report yet. Only produce the structured plan below.

From the intake data, extract and output ONLY the following sections. Be thorough and specific:

1. SAFETY FLAGS
List any conditions that require stopping report generation: active cancer treatment, hospitalization, psychiatric crisis, suicidal ideation. If any present write STOP and the reason. If none write CLEAR.

2. CLIENT PROFILE
Name, age, sex, chief complaint, duration, goals, pregnancy status, cancer history.

3. SIGNIFICANT FINDINGS
List every meaningful symptom, lab value outside functional optimal range, medication, diagnosis, and lifestyle factor. Use actual numbers. Note functional optimal ranges for comparison.

4. PATTERN ANALYSIS
Identify which functional patterns are present: gut/digestive, thyroid/metabolic, blood sugar/insulin, HPA axis/stress, hormonal/perimenopause, immune/inflammatory, mood/mental health, chronic fatigue/mitochondrial. For each pattern present explain the specific data points that trigger it.

5. MODULE SELECTION
List exactly which modules are triggered (1 through 8) and which profile (A through E) is dominant for each. Justify each selection with specific client data. Exclude Module 5 entirely for male clients.

6. SUPPLEMENT PLAN
List every Tier 1 supplement selected across all triggered modules. Apply all rules: maximum 8 total, maximum 3 per module, no duplicates. Apply chromium cross-check if fasting insulin above 6 or sweet cravings severe. Apply CoQ10 cross-check if any statin reported. Note any drug interactions or safety flags for each supplement.

7. DIET PRIORITIES
List the top 3 dietary considerations most relevant to this client based on conditions, medications, symptoms, and test results. Apply all framing rules — no fear language.

8. KEY CONNECTIONS
List at least 3 specific connections between findings that explain why this client feels the way they do. Use actual client data. These will form the backbone of the Why You Feel This Way section.

9. SUGGESTED LABS
List the most relevant labs to suggest based on gaps in current data and triggered modules.

10. RED FLAGS FOR CLINICIAN
List anything that warrants specific medical attention or discussion with a healthcare provider.

Here is the full client intake:

${fullPrompt}`;

    const stage1Result = await callClaude(
      apiKey,
      [{ role: 'user', content: stage1Prompt }],
      2500
    );

    // ── Safety gate between stages ───────────────────────────────────────────
    const upperStage1 = stage1Result.toUpperCase();
    if (upperStage1.includes('SAFETY FLAGS') && upperStage1.includes('STOP')) {
      // Extract the stop reason and return appropriate message
      if (upperStage1.includes('SUICID') || upperStage1.includes('PSYCHIATRIC CRISIS')) {
        const crisisText = 'Thank you for reaching out. Rootiva is not equipped to support someone currently experiencing a mental health crisis. Please contact your mental health provider or call a crisis line. Crisis Text Line: Text HOME to 741741.';
        return res.status(200).json({
          content: [{ type: 'text', text: crisisText }]
        });
      }
      const redirectText = 'Thank you for completing the Rootiva intake. Based on your responses, Rootiva is not the appropriate resource for your current situation. Please connect with your healthcare provider or specialist team who can best support you right now.';
      return res.status(200).json({
        content: [{ type: 'text', text: redirectText }]
      });
    }

    // ── STAGE 2: Full premium client report ──────────────────────────────────
    // Uses Stage 1 clinical plan as foundation. Writes the complete report.

    const stage2Prompt = `You are Rootiva's functional wellness education AI. Write a complete personalized wellness education report for this client.

You are NOT a medical doctor, licensed healthcare provider, diagnostician, or prescriber.
You ARE a functional wellness educator providing educational information only.

A clinical analyst has already processed this client's intake and produced the structured plan below. Use this plan as your foundation. Do not re-analyze — write the report.

CLINICAL PLAN FROM STAGE 1:
${stage1Result}

WRITING RULES:

Every report must feel:
- Intelligent and clinically informed
- Warm, supportive, and emotionally validating
- Personalized to the specific client — use their name throughout
- Educationally grounded — never diagnostic
- Practically useful — not overwhelmingly technical
- Premium and thoughtfully written — not AI-generic

BANNED LANGUAGE — NEVER USE:
- Critically low → use: meaningfully below functional optimal
- You have [condition] → use: may suggest a pattern worth exploring
- Burned out adrenals → use: HPA axis dysregulation
- Heal your gut → use: may support gut lining integrity
- Rewire your nervous system → use: support nervous system regulation
- Push through the fatigue → use: work within your energy envelope
- Immune boosting → use: immune regulation support
- You have depression → use: low mood pattern
- You have anxiety → use: anxiety and nervous system hyperactivation pattern

FORMATTING RULES — MANDATORY:
- Use ## for each major section heading
- Use ### for sub-headings within sections
- Use #### for supplement tier labels
- For supplement entries use: **Supplement Name** — Dose — Brief rationale — Safety note if needed
- Use - for bullet points
- Use **bold** for supplement names and key warnings only
- Do NOT use tables
- Write prose in full sentences with natural paragraph breaks
- Keep sections focused and non-repetitive — never explain the same physiology twice

SUPPLEMENT RULES:
- Present Tier 1 supplements with this opening: "The following are educational wellness considerations only. Please discuss with your healthcare provider before beginning any new supplement."
- Present Tier 2 supplements with this opening: "The following are presented as educational awareness items only — not primary recommendations. Individual suitability must be reviewed by a qualified healthcare provider before considering any of the following."
- Close Tier 2 with: "Your healthcare provider is the right person to help you determine which — if any — of the above considerations are appropriate for your individual picture."
- Never duplicate supplements across modules — reference as already noted above if repeated

DRUG INTERACTION LANGUAGE — always flag clearly when relevant:
- Anticoagulants: flag omega-3, quercetin, CoQ10
- Antidepressants SSRIs SNRIs: note that 5-HTP and SAMe are excluded
- Levothyroxine: always include 4-hour separation rule for iron, calcium, magnesium, fiber, coffee
- Statins: always include CoQ10 education
- Oral contraceptives: add B6, magnesium, zinc, folate, vitamin C depletion note

NEUROPATHY MONITORING — include when relevant:
- B6 as P5P: "If you experience tingling, numbness, or nerve sensations — discontinue immediately"
- Acetyl-L-Carnitine: "Some individuals report increased nerve sensitivity — discontinue if unusual sensations occur"

REPORT STRUCTURE — write every section in this exact order:

## Educational Disclaimer
This report is created for educational and wellness purposes only. It does not constitute medical advice, diagnosis, or treatment. All supplement and dietary considerations should be discussed with a qualified healthcare provider before implementation.

## Patient Snapshot
Brief overview of who this client is and what brought them here.

## What We Found
4 to 6 specific findings with actual client numbers and functional optimal ranges for comparison. Educational framing only.

## Why You Feel This Way
Warm personalized narrative using the client's name. Connect at least 3 specific findings to explain the pattern of how they feel. Make it feel like someone finally understands their picture.

[Then one ## section for each triggered module — use the module name as the heading]
Each module section includes:
- Education on the pattern
- How it connects to this specific client's data
- Tier 1 supplement considerations
- Tier 2 awareness items if relevant
- Cross-references to other modules where appropriate

## Nutrition Highlights
Maximum 3 to 4 dietary considerations. Lead with additions before reductions. Use trial language not elimination language. Include diet closing statement.

## Lifestyle Priorities
3 to 5 specific lifestyle recommendations most relevant to this client's pattern.

## When to See Your Healthcare Provider
Specific flags from this client's picture that warrant professional attention.

## Suggested Labs
Specific labs most relevant to fill gaps in this client's current picture.

## Your 90-Day Wellness Roadmap
Week 1, Weeks 2 to 4, Month 2, Month 3. Realistic and sequential.

## Continue Your Wellness Journey
End with: "[Client name], your wellness picture is not static. As your labs change and symptoms shift, Rootiva can provide updated educational insights. You may consider returning when you have updated lab results, your symptoms have meaningfully changed, or it has been several months since your last report."

## Educational Disclaimer
This report is created for educational and wellness purposes only. It does not constitute medical advice, diagnosis, or treatment. All supplement and dietary considerations should be discussed with a qualified healthcare provider before implementation.

Now write the complete premium report. Be warm, specific, intelligent, and genuinely personalized.`;

    const stage2Result = await callClaude(
      apiKey,
      [{ role: 'user', content: stage2Prompt }],
      6000
    );

    return res.status(200).json({
      content: [{ type: 'text', text: stage2Result }]
    });

  } catch (err) {
    console.error('Generation error:', err.message);
    return res.status(502).json({
      error: { type: 'generation_error', message: err.message }
    });
  }
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', architecture: '2-stage' });
});

app.listen(PORT, () => {
  console.log('Rootiva server running on port ' + PORT + ' — 2-stage architecture');
});
