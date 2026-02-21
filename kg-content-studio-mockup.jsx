import { useState, useEffect, useRef } from "react";

const PLATFORMS = [
  { id: "instagram", label: "Instagram", icon: "📸", color: "#E1306C", charLimit: 2200, desc: "Visual storytelling", category: "social" },
  { id: "facebook", label: "Facebook", icon: "📘", color: "#1877F2", charLimit: 63206, desc: "Community engagement", category: "social" },
  { id: "linkedin", label: "LinkedIn", icon: "💼", color: "#0A66C2", charLimit: 3000, desc: "Professional network", category: "social" },
  { id: "twitter", label: "X / Twitter", icon: "𝕏", color: "#1d1d1d", charLimit: 280, desc: "Quick impact", category: "social" },
  { id: "tiktok", label: "TikTok", icon: "🎵", color: "#ff0050", charLimit: 4000, desc: "Script + caption", category: "video" },
  { id: "youtube", label: "YouTube", icon: "▶️", color: "#FF0000", charLimit: 5000, desc: "Script + metadata", category: "video" },
  { id: "email", label: "Newsletter", icon: "✉️", color: "#D44638", charLimit: null, desc: "Direct connection", category: "written" },
  { id: "blog", label: "Blog", icon: "✍️", color: "#2D6A4F", charLimit: null, desc: "Deep storytelling", category: "written" },
];

const BRIEF_FIELDS = {
  default: [
    { id: "topic", label: "What's this about?", placeholder: "Spring chess tournament, summer camp registration, fundraiser recap...", type: "textarea" },
    { id: "audience", label: "Who's the audience?", placeholder: "Parents, donors, community partners, volunteers...", type: "select", options: ["Parents & Families", "Donors & Sponsors", "Community Partners", "Volunteers & Staff", "General Public", "Kids & Teens"] },
    { id: "cta", label: "What should they do?", placeholder: "Register, donate, share, attend, volunteer...", type: "text" },
    { id: "details", label: "Key details", placeholder: "Dates, location, links, names, costs — anything specific", type: "textarea" },
  ],
  blog: [
    { id: "topic", label: "What story do you want to tell?", placeholder: "A moment from practice, a kid's breakthrough, why chess matters, a season reflection...", type: "textarea" },
    { id: "feeling", label: "What should the reader feel?", placeholder: "Inspired, connected, understood, motivated to act...", type: "select", options: ["Inspired & Uplifted", "Connected to the mission", "Moved to take action", "Understanding our impact", "Part of the community", "Reflective & thoughtful"] },
    { id: "moment", label: "Is there a specific moment or person that captures this?", placeholder: "Last Tuesday a kid who hadn't spoken all semester checkmated his instructor...", type: "textarea" },
    { id: "details", label: "Any details to include?", placeholder: "Names (with permission), dates, program details, quotes...", type: "textarea" },
  ],
  tiktok: [
    { id: "topic", label: "What's the video about?", placeholder: "A day at practice, a student spotlight, a quick chess tip, event hype...", type: "textarea" },
    { id: "hook", label: "What grabs attention in the first 2 seconds?", placeholder: "A surprising fact, a bold statement, a question, a visual moment...", type: "text" },
    { id: "audience", label: "Who's this for?", placeholder: "Parents, donors, community partners, volunteers...", type: "select", options: ["Parents & Families", "Donors & Sponsors", "Community Partners", "General Public", "Kids & Teens", "Potential Volunteers"] },
    { id: "details", label: "Key details or talking points", placeholder: "What should be mentioned — dates, names, events, links in bio...", type: "textarea" },
  ],
  youtube: [
    { id: "topic", label: "What's the video about?", placeholder: "Program overview, event recap, interview with a coach, student journey...", type: "textarea" },
    { id: "audience", label: "Who's watching this?", placeholder: "Parents, donors, community partners, volunteers...", type: "select", options: ["Parents & Families", "Donors & Sponsors", "Community Partners", "General Public", "Kids & Teens", "Potential Volunteers"] },
    { id: "style", label: "What kind of video?", placeholder: "Choose the format...", type: "select", options: ["Talking Head / Vlog", "Event Recap", "Tutorial / How-To", "Student Spotlight", "Program Overview", "Behind the Scenes"] },
    { id: "details", label: "Key points to cover", placeholder: "Main talking points, names, dates, anything specific to include...", type: "textarea" },
  ],
};

const PROMPT_TEMPLATES = {
  instagram: `Post announcing our spring chess tournament on March 15th at PS 234. Target audience is parents of kids ages 6-14. Include registration link. Tone: excited but informational.`,
  facebook: `Post recapping last weekend's tennis clinic. 40 kids attended, ages 8-16. Highlight the volunteer coaches. Ask parents to share photos. Warm and community-focused.`,
  linkedin: `Post about our impact this year — 200+ kids served, 3 new partnerships. Audience: potential donors and corporate sponsors. Professional but heartfelt.`,
  twitter: `Tweet announcing summer camp registration opens Monday. Ages 6-14. Link in bio. Make it punchy and shareable.`,
  tiktok: `30-second video script showing a typical Saturday at practice. Open with a kid making a great tennis shot, cut to chess boards, end with the group photo. Caption should be fun and inviting. Target: local parents scrolling.`,
  youtube: `5-minute video script: "What is Community Literacy Club?" Program overview for parents considering enrollment. Cover tennis, chess, mentorship, and what a typical day looks like. Friendly, authentic, not overly produced.`,
  email: `Monthly newsletter covering: spring tournament results, upcoming summer camp, volunteer spotlight on Coach Davis. Audience: our full mailing list of parents and supporters.`,
  blog: `Blog post about why we teach chess and tennis together — how strategic thinking on the board translates to the court. Include the story of Marcus, age 11, who joined shy and is now leading warm-ups. Audience: parents considering enrollment and donors who want to understand our approach.`,
};

const ChatBubble = ({ message, isAgent, isTyping }) => (
  <div style={{
    display: "flex",
    justifyContent: isAgent ? "flex-start" : "flex-end",
    marginBottom: 12,
    animation: "fadeSlideUp 0.3s ease-out",
  }}>
    <div style={{
      maxWidth: "80%",
      padding: "14px 18px",
      borderRadius: isAgent ? "4px 18px 18px 18px" : "18px 4px 18px 18px",
      background: isAgent ? "#1a1f2e" : "#2D6A4F",
      color: isAgent ? "#c8d0e0" : "#ffffff",
      fontSize: 14,
      lineHeight: 1.65,
      fontFamily: "'Source Serif 4', Georgia, serif",
      border: isAgent ? "1px solid #262d40" : "none",
      whiteSpace: "pre-wrap",
    }}>
      {isTyping ? (
        <span style={{ display: "flex", gap: 4, padding: "4px 0" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4a5578", animation: "pulse 1s infinite" }} />
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4a5578", animation: "pulse 1s infinite 0.15s" }} />
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4a5578", animation: "pulse 1s infinite 0.3s" }} />
        </span>
      ) : message}
    </div>
  </div>
);

const OutputCard = ({ content, platform }) => {
  const [copied, setCopied] = useState(false);
  const p = PLATFORMS.find(pl => pl.id === platform);
  const isVideo = p?.category === "video";

  return (
    <div style={{
      background: "#111520",
      border: "1px solid #1e2538",
      borderRadius: 12,
      padding: 24,
      animation: "fadeSlideUp 0.4s ease-out",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 20 }}>{p?.icon}</span>
          <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: 2 }}>
            <span style={{ color: p?.color }}>{p?.label}</span>
            <span style={{ color: "#4a5578" }}> — {isVideo ? "Script + Caption Ready" : "Ready to Publish"}</span>
          </span>
        </div>
        {p?.charLimit && (
          <span style={{
            fontSize: 11,
            color: content.length > p.charLimit ? "#ef4444" : "#4a5578",
            fontFamily: "'Space Mono', monospace",
          }}>
            {content.length} / {p.charLimit.toLocaleString()}
          </span>
        )}
      </div>
      <div style={{
        color: "#e2e8f0",
        fontSize: 15,
        lineHeight: 1.75,
        fontFamily: "'Source Serif 4', Georgia, serif",
        whiteSpace: "pre-wrap",
        padding: "16px 0",
        borderTop: "1px solid #1e2538",
        borderBottom: "1px solid #1e2538",
        marginBottom: 16,
      }}>
        {content}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={() => { navigator.clipboard?.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          style={{
            padding: "10px 20px",
            borderRadius: 8,
            border: "1px solid #2D6A4F",
            background: "transparent",
            color: "#2D6A4F",
            cursor: "pointer",
            fontFamily: "'Space Mono', monospace",
            fontSize: 12,
            letterSpacing: 1,
            transition: "all 0.2s",
          }}
        >
          {copied ? "✓ Copied" : "Copy to Clipboard"}
        </button>
        <button style={{
          padding: "10px 20px",
          borderRadius: 8,
          border: "none",
          background: "#2D6A4F",
          color: "#ffffff",
          cursor: "pointer",
          fontFamily: "'Space Mono', monospace",
          fontSize: 12,
          letterSpacing: 1,
          opacity: 0.5,
        }}>
          Send to Make.com →
        </button>
      </div>
    </div>
  );
};

export default function ContentStudio() {
  const [step, setStep] = useState("platform");
  const [selectedPlatform, setSelectedPlatform] = useState(null);
  const [briefData, setBriefData] = useState({});
  const [messages, setMessages] = useState([]);
  const [userInput, setUserInput] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedContent, setGeneratedContent] = useState(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handlePlatformSelect = (platform) => {
    setSelectedPlatform(platform);
    setStep("brief");
  };

  const getFieldsForPlatform = (platformId) => {
    if (BRIEF_FIELDS[platformId]) return BRIEF_FIELDS[platformId];
    return BRIEF_FIELDS.default;
  };

  const handleBriefSubmit = () => {
    const p = PLATFORMS.find(pl => pl.id === selectedPlatform);
    const isVideo = p?.category === "video";
    setStep("conversation");

    const briefSummary = Object.entries(briefData)
      .filter(([_, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    const contentType = selectedPlatform === "blog" ? "a blog post" :
      isVideo ? `a ${p.label} script and caption` :
      `a ${p.label} post`;

    setMessages([
      {
        isAgent: true,
        text: `Got it — working on ${contentType}. Here's what I have so far:\n\n${briefSummary}\n\nLet me ask a couple things to make this stronger...`,
      },
    ]);

    setTimeout(() => {
      let followUps;
      if (selectedPlatform === "blog") {
        followUps = "What's the one line you'd want someone to remember after reading this? And is there a specific image or scene from that moment — what did it look like, sound like?";
      } else if (selectedPlatform === "tiktok") {
        followUps = "How long should the video be — 15 seconds, 30, or 60? And do you want on-screen text callouts, or is this more of a voiceover style?";
      } else if (selectedPlatform === "youtube") {
        followUps = "What's the ideal length for this video? And should the tone feel polished and produced, or more casual and authentic — like someone's just talking to the camera?";
      } else {
        followUps = "Is there a specific link or URL to include? And should this feel more like an announcement or more like a personal share?";
      }

      setMessages(prev => [...prev, { isAgent: true, text: followUps }]);
    }, 1500);
  };

  const handleSendMessage = () => {
    if (!userInput.trim()) return;
    setMessages(prev => [...prev, { isAgent: false, text: userInput }]);
    setUserInput("");

    setTimeout(() => {
      setMessages(prev => [...prev, { isAgent: true, isTyping: true }]);
    }, 400);

    setTimeout(() => {
      setMessages(prev => {
        const filtered = prev.filter(m => !m.isTyping);
        return [...filtered, {
          isAgent: true,
          text: "Perfect — I have everything I need. Generating your content now...",
        }];
      });

      setIsGenerating(true);

      setTimeout(() => {
        const sampleOutputs = {
          instagram: `There's this thing that happens on the court right before a kid serves for the first time.\n\nThey look around. They adjust their grip three times. They take a breath.\n\nThen they swing.\n\nAnd it doesn't matter if it goes over the net or into the fence — what matters is they swung.\n\nSpring registration is open. Ages 6-14.\nLink in bio.\n\n🎾♟️ #CommunityLiteracyClub #YouthTennis #ChessLife #BrooklynKids #SpringPrograms`,

          facebook: `Registration is live for spring programs at Community Literacy Club.\n\nWe're running sessions for ages 6-14, Saturdays at Prospect Park starting March 8th. Tennis in the morning, chess in the afternoon. Same coaches your kids already know.\n\nNew this year: our teen leadership track for ages 13-16 who want to assist with younger groups.\n\nSpots fill up. They filled up last spring by the second week.\n\nRegistration link below. DM us with questions.`,

          linkedin: `When we started Community Literacy Club, the idea was simple: give kids in Brooklyn access to two games that teach them how to think.\n\nThree years in, we've served 200+ young people. Our retention rate is 84%. We have kids who started at age 7 now mentoring the new cohort.\n\nThis spring we're expanding to two additional sites and launching a teen leadership track.\n\nWe're looking for corporate partners who believe that strategic thinking — on the court and on the board — is a skill every kid deserves to develop.\n\nIf that resonates, I'd welcome a conversation.`,

          twitter: `Spring registration is open.\n\nTennis + chess. Ages 6-14. Brooklyn.\n\nThe kids who started three years ago are now teaching the new ones.\n\nThat's the whole point.\n\n🎾♟️ Link in bio.`,

          tiktok: `📱 SCRIPT\n\n[HOOK — first 2 seconds]\nVisual: Close-up of a chess piece being placed. SNAP to a tennis ball being served.\nText on screen: "This is what Saturdays look like."\n\n[BODY — 15-25 seconds]\nQuick cuts:\n→ Kids warming up on the court\n→ A coach high-fiving a student\n→ Two kids focused over a chess board\n→ A group laughing between sets\n→ A kid making their first successful serve\n\nVoiceover or text overlay:\n"Tennis in the morning. Chess in the afternoon. Every Saturday in Brooklyn."\n\n[CTA — last 3 seconds]\nText on screen: "Spring registration open now"\nPoint to link in bio\n\n---\n\n📝 CAPTION\n\nSaturdays at Community Literacy Club hit different 🎾♟️\n\nTennis + chess. Ages 6-14. Spring registration is live — link in bio.\n\n#CommunityLiteracyClub #BrooklynKids #YouthTennis #ChessLife #SaturdayVibes #KidsActivities #AfterSchool`,

          youtube: `📹 VIDEO SCRIPT\n\nTITLE: What is Community Literacy Club? | Tennis, Chess & Mentorship in Brooklyn\n\nDESCRIPTION:\nCommunity Literacy Club brings tennis and chess together for kids ages 6-14 in Brooklyn. In this video, learn about our Saturday programs, meet our coaches, and see why 200+ families trust us with their kids' development.\n\n🎾 Spring registration: [LINK]\n♟️ Learn more: [LINK]\n\n---\n\nSCRIPT\n\n[INTRO — 0:00-0:30]\n(B-roll of kids on court, chess boards being set up)\n\n"If someone told you that tennis and chess belong together, you'd probably ask why. That's fair. So let me show you."\n\n[SECTION 1: THE PROGRAM — 0:30-1:30]\n"Every Saturday at Prospect Park, kids ages 6 to 14 show up for two things. In the morning, they're on the court — learning serves, footwork, how to compete. In the afternoon, they're at the board — learning openings, strategy, how to think three moves ahead."\n\n"The connection isn't obvious until you watch it happen. A kid who learned patience waiting for the right chess move starts waiting for the right moment to swing. A kid who learned to read their opponent across the net starts reading the board differently."\n\n[SECTION 2: THE COACHES — 1:30-2:30]\n(Introduce 1-2 coaches, quick sound bites)\n\n"Our coaches aren't just instructors — they're mentors. They know every kid by name. They know who needs a push and who needs space."\n\n[SECTION 3: THE IMPACT — 2:30-3:30]\n"Three years. 200+ kids. 84% retention rate. And now, kids who started at age 7 are mentoring the new ones."\n\n(Quick testimonial from a parent or older student)\n\n[OUTRO — 3:30-4:00]\n"Spring registration is open now. Link in the description. Come see what Saturdays can be."\n\n---\n\nTAGS: community literacy club, youth tennis brooklyn, chess for kids, after school programs brooklyn, kids activities nyc, tennis and chess, youth mentorship`,

          email: `Subject: Spring is here — and so is registration\n\nHi everyone,\n\nQuick update from Community Literacy Club:\n\nSpring programs start March 8th. Same format — tennis mornings, chess afternoons, Saturdays at Prospect Park. We're adding a second location this year at Fort Greene.\n\nNew this season: a teen leadership track for ages 13-16. Kids who've been with us can apply to assist with younger groups. It's something they've been asking for.\n\nCoach Davis is back. So is Coach Reina. We're adding two new instructors you'll meet at orientation.\n\nRegistration link below. Early bird rate ends February 28th.\n\nSee you on the court.\n\n— Community Literacy Club`,

          blog: `There's a moment I think about often.\n\nIt was a Saturday last October. We were mid-session at Prospect Park — tennis wrapping up, chess about to start. One of our kids, I'll call him D, was sitting on the bench doing what he always did: watching.\n\nD had been with us for six weeks at that point. Showed up every Saturday. Never missed. But he hadn't picked up a racket and he hadn't touched a chess piece. His mom told me he was like that — needed time.\n\nSo we gave him time.\n\nWeek seven, Coach Davis set up a board at the end of D's bench. Didn't say anything. Just set it up and walked away.\n\nTwenty minutes later I looked over and D was moving pieces. Not playing a game — just moving them. Learning how they traveled across the board. The knight especially. He kept picking it up, putting it down, counting squares.\n\nBy week ten he was playing. By December he was beating kids who'd been playing for a year.\n\nI'm not telling this story because it's extraordinary. I'm telling it because it's ordinary. It happens here all the time. A kid shows up closed and leaves open. Not because we forced anything — because we built a space where they could decide for themselves when to step in.\n\nThat's what tennis and chess have in common, when you really think about it. Nobody can play for you. The coach can teach you the grip, show you the opening, explain the strategy. But when it's your serve or your move — it's yours.\n\nWe teach kids two games. But what we're actually teaching is the willingness to try when you're not sure you're ready.\n\nSpring registration is open now. If you know a kid who needs a place to land, send them our way. We're good at waiting.`,
        };

        setGeneratedContent(sampleOutputs[selectedPlatform] || sampleOutputs.instagram);
        setIsGenerating(false);
      }, 3000);
    }, 2000);
  };

  const categories = [
    { id: "social", label: "Social Media" },
    { id: "video", label: "Video" },
    { id: "written", label: "Long-Form" },
  ];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,600;8..60,700&family=Space+Mono:wght@400;700&display=swap');

        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.2); }
        }

        @keyframes shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a3148; border-radius: 4px; }

        textarea:focus, input:focus, select:focus {
          border-color: #2D6A4F55 !important;
          outline: none;
        }
      `}</style>

      <div style={{
        minHeight: "100vh",
        background: "#0a0d14",
        color: "#e2e8f0",
        fontFamily: "'Source Serif 4', Georgia, serif",
      }}>
        {/* Header */}
        <header style={{
          padding: "24px 40px",
          borderBottom: "1px solid #141824",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          <div>
            <h1 style={{
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#ffffff",
            }}>
              Community Literacy Club
            </h1>
            <p style={{
              fontFamily: "'Space Mono', monospace",
              fontSize: 11,
              color: "#4a5578",
              marginTop: 4,
              letterSpacing: 0.5,
            }}>
              Content Studio
            </p>
          </div>

          <button
            onClick={() => setShowTemplates(!showTemplates)}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "1px solid #1e2538",
              background: showTemplates ? "#1e2538" : "transparent",
              color: "#8892b0",
              cursor: "pointer",
              fontFamily: "'Space Mono', monospace",
              fontSize: 11,
              letterSpacing: 0.5,
              transition: "all 0.2s",
            }}
          >
            {showTemplates ? "✕ Close" : "💡 Prompt Tips"}
          </button>
        </header>

        <div style={{ display: "flex", minHeight: "calc(100vh - 81px)" }}>
          {/* Main Content */}
          <main style={{ flex: 1, padding: "32px 40px", maxWidth: 800, margin: "0 auto" }}>

            {/* Step 1: Platform Selection */}
            {step === "platform" && (
              <div style={{ animation: "fadeSlideUp 0.4s ease-out" }}>
                <div style={{ marginBottom: 36 }}>
                  <h2 style={{ fontSize: 28, fontWeight: 300, marginBottom: 8, letterSpacing: "-0.01em" }}>
                    What are we creating?
                  </h2>
                  <p style={{ color: "#4a5578", fontSize: 15 }}>
                    Choose the platform — it shapes how the content is written.
                  </p>
                </div>

                {categories.map((cat) => (
                  <div key={cat.id} style={{ marginBottom: 24 }}>
                    <div style={{
                      fontFamily: "'Space Mono', monospace",
                      fontSize: 10,
                      color: "#4a5578",
                      letterSpacing: 2,
                      textTransform: "uppercase",
                      marginBottom: 10,
                    }}>
                      {cat.label}
                    </div>
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: cat.id === "social" ? "repeat(4, 1fr)" : "repeat(2, 1fr)",
                      gap: 10,
                    }}>
                      {PLATFORMS.filter(p => p.category === cat.id).map((p) => (
                        <button
                          key={p.id}
                          onClick={() => handlePlatformSelect(p.id)}
                          style={{
                            padding: "20px 16px",
                            borderRadius: 10,
                            border: "1px solid #1e2538",
                            background: "#111520",
                            cursor: "pointer",
                            textAlign: "left",
                            transition: "all 0.25s",
                            position: "relative",
                            overflow: "hidden",
                          }}
                          onMouseEnter={e => {
                            e.currentTarget.style.borderColor = p.color + "66";
                            e.currentTarget.style.background = "#141824";
                          }}
                          onMouseLeave={e => {
                            e.currentTarget.style.borderColor = "#1e2538";
                            e.currentTarget.style.background = "#111520";
                          }}
                        >
                          <div style={{ fontSize: 24, marginBottom: 10 }}>{p.icon}</div>
                          <div style={{
                            fontFamily: "'Space Mono', monospace",
                            fontSize: 12,
                            fontWeight: 700,
                            color: "#ffffff",
                            marginBottom: 3,
                            letterSpacing: 0.5,
                          }}>
                            {p.label}
                          </div>
                          <div style={{
                            fontFamily: "'Space Mono', monospace",
                            fontSize: 10,
                            color: "#4a5578",
                            letterSpacing: 0.3,
                          }}>
                            {p.desc}
                          </div>
                          <div style={{
                            position: "absolute",
                            top: 0,
                            right: 0,
                            width: 3,
                            height: "100%",
                            background: p.color,
                            opacity: 0.35,
                            borderRadius: "0 10px 10px 0",
                          }} />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Step 2: Brief */}
            {step === "brief" && (
              <div style={{ animation: "fadeSlideUp 0.4s ease-out" }}>
                <div style={{ marginBottom: 32 }}>
                  <button
                    onClick={() => { setStep("platform"); setSelectedPlatform(null); setBriefData({}); }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#4a5578",
                      cursor: "pointer",
                      fontFamily: "'Space Mono', monospace",
                      fontSize: 11,
                      marginBottom: 16,
                      letterSpacing: 0.5,
                    }}
                  >
                    ← Back to platforms
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                    <span style={{ fontSize: 24 }}>{PLATFORMS.find(p => p.id === selectedPlatform)?.icon}</span>
                    <h2 style={{ fontSize: 24, fontWeight: 300 }}>
                      {selectedPlatform === "blog" ? "Tell us the story" :
                       selectedPlatform === "tiktok" ? "Plan the video" :
                       selectedPlatform === "youtube" ? "Outline the video" :
                       "Fill in the brief"}
                    </h2>
                  </div>
                  <p style={{ color: "#4a5578", fontSize: 14 }}>
                    {selectedPlatform === "blog"
                      ? "Blog posts need depth. The more you share, the more authentic the piece."
                      : selectedPlatform === "tiktok"
                      ? "We'll write the script, caption, and hashtags. You bring the camera."
                      : selectedPlatform === "youtube"
                      ? "We'll write the full script, title, description, and tags."
                      : "Give enough context to work with — follow-up questions come next."}
                  </p>
                </div>

                {getFieldsForPlatform(selectedPlatform).map((field) => (
                  <div key={field.id} style={{ marginBottom: 20 }}>
                    <label style={{
                      display: "block",
                      fontFamily: "'Space Mono', monospace",
                      fontSize: 11,
                      color: "#8892b0",
                      marginBottom: 8,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                    }}>
                      {field.label}
                    </label>
                    {field.type === "textarea" ? (
                      <textarea
                        value={briefData[field.id] || ""}
                        onChange={e => setBriefData(prev => ({ ...prev, [field.id]: e.target.value }))}
                        placeholder={field.placeholder}
                        rows={3}
                        style={{
                          width: "100%",
                          padding: "14px 16px",
                          borderRadius: 8,
                          border: "1px solid #1e2538",
                          background: "#111520",
                          color: "#e2e8f0",
                          fontSize: 14,
                          fontFamily: "'Source Serif 4', Georgia, serif",
                          lineHeight: 1.6,
                          resize: "vertical",
                          outline: "none",
                        }}
                      />
                    ) : field.type === "select" ? (
                      <select
                        value={briefData[field.id] || ""}
                        onChange={e => setBriefData(prev => ({ ...prev, [field.id]: e.target.value }))}
                        style={{
                          width: "100%",
                          padding: "14px 16px",
                          borderRadius: 8,
                          border: "1px solid #1e2538",
                          background: "#111520",
                          color: briefData[field.id] ? "#e2e8f0" : "#4a5578",
                          fontSize: 14,
                          fontFamily: "'Source Serif 4', Georgia, serif",
                          outline: "none",
                          cursor: "pointer",
                        }}
                      >
                        <option value="">{field.placeholder}</option>
                        {field.options.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={briefData[field.id] || ""}
                        onChange={e => setBriefData(prev => ({ ...prev, [field.id]: e.target.value }))}
                        placeholder={field.placeholder}
                        style={{
                          width: "100%",
                          padding: "14px 16px",
                          borderRadius: 8,
                          border: "1px solid #1e2538",
                          background: "#111520",
                          color: "#e2e8f0",
                          fontSize: 14,
                          fontFamily: "'Source Serif 4', Georgia, serif",
                          outline: "none",
                        }}
                      />
                    )}
                  </div>
                ))}

                <button
                  onClick={handleBriefSubmit}
                  disabled={!briefData.topic && !briefData.hook}
                  style={{
                    width: "100%",
                    padding: "16px",
                    borderRadius: 8,
                    border: "none",
                    background: (briefData.topic || briefData.hook) ? "#2D6A4F" : "#1e2538",
                    color: (briefData.topic || briefData.hook) ? "#ffffff" : "#4a5578",
                    fontSize: 14,
                    fontFamily: "'Space Mono', monospace",
                    fontWeight: 700,
                    letterSpacing: 1,
                    cursor: (briefData.topic || briefData.hook) ? "pointer" : "not-allowed",
                    transition: "all 0.25s",
                    marginTop: 8,
                  }}
                >
                  Continue →
                </button>
              </div>
            )}

            {/* Step 3: Conversation */}
            {step === "conversation" && (
              <div style={{ animation: "fadeSlideUp 0.4s ease-out" }}>
                <div style={{ marginBottom: 24 }}>
                  <button
                    onClick={() => { setStep("brief"); setMessages([]); setGeneratedContent(null); }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#4a5578",
                      cursor: "pointer",
                      fontFamily: "'Space Mono', monospace",
                      fontSize: 11,
                      marginBottom: 16,
                      letterSpacing: 0.5,
                    }}
                  >
                    ← Back to brief
                  </button>
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontFamily: "'Space Mono', monospace",
                    fontSize: 11,
                    color: "#4a5578",
                    letterSpacing: 1,
                  }}>
                    <span style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: "#2D6A4F",
                      display: "inline-block",
                    }} />
                    REFINING YOUR CONTENT
                  </div>
                </div>

                <div style={{
                  minHeight: 200,
                  maxHeight: 400,
                  overflowY: "auto",
                  marginBottom: 20,
                  paddingRight: 8,
                }}>
                  {messages.map((msg, i) => (
                    <ChatBubble key={i} message={msg.text} isAgent={msg.isAgent} isTyping={msg.isTyping} />
                  ))}
                  <div ref={chatEndRef} />
                </div>

                {!generatedContent && (
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                    <textarea
                      value={userInput}
                      onChange={e => setUserInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
                      placeholder="Answer the questions or add more context..."
                      rows={2}
                      style={{
                        flex: 1,
                        padding: "14px 16px",
                        borderRadius: 8,
                        border: "1px solid #1e2538",
                        background: "#111520",
                        color: "#e2e8f0",
                        fontSize: 14,
                        fontFamily: "'Source Serif 4', Georgia, serif",
                        lineHeight: 1.5,
                        resize: "none",
                        outline: "none",
                      }}
                    />
                    <button
                      onClick={handleSendMessage}
                      style={{
                        padding: "14px 20px",
                        borderRadius: 8,
                        border: "none",
                        background: "#2D6A4F",
                        color: "#ffffff",
                        cursor: "pointer",
                        fontFamily: "'Space Mono', monospace",
                        fontSize: 12,
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                      }}
                    >
                      Send
                    </button>
                  </div>
                )}

                {isGenerating && (
                  <div style={{
                    textAlign: "center",
                    padding: "32px 0",
                    animation: "fadeSlideUp 0.3s ease-out",
                  }}>
                    <div style={{
                      fontFamily: "'Space Mono', monospace",
                      fontSize: 12,
                      color: "#2D6A4F",
                      letterSpacing: 2,
                      background: "linear-gradient(90deg, #2D6A4F, #4a9e7a, #2D6A4F)",
                      backgroundSize: "200% auto",
                      WebkitBackgroundClip: "text",
                      WebkitTextFillColor: "transparent",
                      animation: "shimmer 2s linear infinite",
                    }}>
                      GENERATING CONTENT...
                    </div>
                  </div>
                )}

                {generatedContent && !isGenerating && (
                  <div style={{ marginTop: 24 }}>
                    <OutputCard content={generatedContent} platform={selectedPlatform} />
                    <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                      <button
                        onClick={() => {
                          setGeneratedContent(null);
                          setMessages(prev => [...prev, {
                            isAgent: true,
                            text: "Want me to adjust anything? Different angle, shorter, more personal — just say the word.",
                          }]);
                        }}
                        style={{
                          flex: 1,
                          padding: "12px",
                          borderRadius: 8,
                          border: "1px solid #1e2538",
                          background: "transparent",
                          color: "#8892b0",
                          cursor: "pointer",
                          fontFamily: "'Space Mono', monospace",
                          fontSize: 12,
                          letterSpacing: 0.5,
                        }}
                      >
                        ✏️ Refine this
                      </button>
                      <button
                        onClick={() => {
                          setStep("platform");
                          setSelectedPlatform(null);
                          setBriefData({});
                          setMessages([]);
                          setGeneratedContent(null);
                        }}
                        style={{
                          flex: 1,
                          padding: "12px",
                          borderRadius: 8,
                          border: "1px solid #1e2538",
                          background: "transparent",
                          color: "#8892b0",
                          cursor: "pointer",
                          fontFamily: "'Space Mono', monospace",
                          fontSize: 12,
                          letterSpacing: 0.5,
                        }}
                      >
                        🆕 New content
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </main>

          {/* Sidebar: Prompt Templates */}
          {showTemplates && (
            <aside style={{
              width: 340,
              borderLeft: "1px solid #141824",
              padding: "32px 24px",
              overflowY: "auto",
              animation: "fadeSlideUp 0.3s ease-out",
              background: "#0d1018",
            }}>
              <h3 style={{
                fontFamily: "'Space Mono', monospace",
                fontSize: 11,
                letterSpacing: 2,
                textTransform: "uppercase",
                color: "#4a5578",
                marginBottom: 20,
              }}>
                💡 Example Prompts
              </h3>
              <p style={{
                fontSize: 13,
                color: "#4a5578",
                marginBottom: 24,
                lineHeight: 1.6,
              }}>
                The more specific you are, the better the output. Use these as a starting point.
              </p>

              {PLATFORMS.map((p) => (
                <div key={p.id} style={{
                  marginBottom: 14,
                  padding: "14px",
                  borderRadius: 8,
                  border: "1px solid #1e2538",
                  background: "#111520",
                }}>
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 10,
                  }}>
                    <span style={{ fontSize: 14 }}>{p.icon}</span>
                    <span style={{
                      fontFamily: "'Space Mono', monospace",
                      fontSize: 11,
                      color: p.color,
                      fontWeight: 700,
                      letterSpacing: 0.5,
                    }}>
                      {p.label}
                    </span>
                  </div>
                  <p style={{
                    fontSize: 12,
                    color: "#8892b0",
                    lineHeight: 1.65,
                    fontStyle: "italic",
                  }}>
                    "{PROMPT_TEMPLATES[p.id]}"
                  </p>
                </div>
              ))}
            </aside>
          )}
        </div>

        {/* Footer */}
        <footer style={{
          padding: "14px 40px",
          borderTop: "1px solid #141824",
          textAlign: "center",
        }}>
          <span style={{
            fontFamily: "'Space Mono', monospace",
            fontSize: 10,
            color: "#2a3148",
            letterSpacing: 1,
          }}>
            Community Literacy Club
          </span>
        </footer>
      </div>
    </>
  );
}
