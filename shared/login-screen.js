// Sign-in, registration and password-reset screen shared by the Command Center and the mobile app.
(function (global) {
  const $ = (id) => document.getElementById(id);
  const PHONE_RE = /^[6-9]\d{9}$/;
  const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;
  const ROLE_HINTS = {
    citizen: "Report flooding, check in safe and get approved alerts.",
    volunteer: "Verified volunteers: see approved tasks that match your skills.",
    staff: "Command Center staff: incident commanders, verifiers and administrators."
  };

  // [English, Hindi, Tamil, Malayalam, Kannada] for the sign-in, registration and reset screens.
  const LOGIN_PHRASES = [
    ["Protecting communities during emergencies", "आपात स्थितियों में समुदायों की सुरक्षा", "அவசர காலங்களில் சமூகங்களைப் பாதுகாத்தல்", "അടിയന്തര ഘട്ടങ്ങളിൽ സമൂഹങ്ങളെ സംരക്ഷിക്കുന്നു", "ತುರ್ತು ಸಂದರ್ಭಗಳಲ್ಲಿ ಸಮುದಾಯಗಳ ರಕ್ಷಣೆ"],
    ["Real-time monitoring", "रीयल-टाइम निगरानी", "நேரடி கண்காணிப்பு", "തത്സമയ നിരീക്ഷണം", "ನೈಜ-ಸಮಯದ ಮೇಲ್ವಿಚಾರಣೆ"],
    ["Incident management", "घटना प्रबंधन", "சம்பவ மேலாண்மை", "സംഭവ നിർവഹണം", "ಘಟನೆ ನಿರ್ವಹಣೆ"],
    ["Resource coordination", "संसाधन समन्वय", "வள ஒருங்கிணைப்பு", "വിഭവ ഏകോപനം", "ಸಂಪನ್ಮೂಲ ಸಮನ್ವಯ"],
    ["Emergency communication", "आपातकालीन संचार", "அவசரத் தொடர்பு", "അടിയന്തര ആശയവിനിമയം", "ತುರ್ತು ಸಂವಹನ"],
    ["Emergency alerts", "आपातकालीन चेतावनियाँ", "அவசர எச்சரிக்கைகள்", "അടിയന്തര മുന്നറിയിപ്പുകൾ", "ತುರ್ತು ಎಚ್ಚರಿಕೆಗಳು"],
    ["Disaster tracking", "आपदा ट्रैकिंग", "பேரிடர் கண்காணிப்பு", "ദുരന്ത നിരീക്ഷണം", "ವಿಪತ್ತು ಮೇಲ್ವಿಚಾರಣೆ"],
    ["Shelter management", "आश्रय प्रबंधन", "தங்குமிட மேலாண்மை", "അഭയകേന്ദ്ര നിർവഹണം", "ಆಶ್ರಯ ನಿರ್ವಹಣೆ"],
    ["Volunteer coordination", "स्वयंसेवक समन्वय", "தன்னார்வலர் ஒருங்கிணைப்பு", "സന്നദ്ധസേവക ഏകോപനം", "ಸ್ವಯಂಸೇವಕ ಸಮನ್ವಯ"],
    ["Resource deployment", "संसाधन तैनाती", "வளங்களை அனுப்புதல்", "വിഭവ വിന്യാസം", "ಸಂಪನ್ಮೂಲ ನಿಯೋಜನೆ"],
    ["Incident reporting", "घटना रिपोर्टिंग", "சம்பவ அறிக்கை", "സംഭവ റിപ്പോർട്ടിംഗ്", "ಘಟನೆ ವರದಿ"],
    ["Sign in to ASHRAAY", "ASHRAAY में साइन इन करें", "ASHRAAY-இல் உள்நுழைக", "ASHRAAY-ൽ സൈൻ ഇൻ ചെയ്യുക", "ASHRAAY ಗೆ ಸೈನ್ ಇನ್ ಮಾಡಿ"],
    ["Register with ASHRAAY", "ASHRAAY में पंजीकरण करें", "ASHRAAY-இல் பதிவு செய்க", "ASHRAAY-ൽ രജിസ്റ്റർ ചെയ്യുക", "ASHRAAY ನಲ್ಲಿ ನೋಂದಾಯಿಸಿ"],
    ["Together for safer, resilient communities", "सुरक्षित, सशक्त समुदायों के लिए साथ मिलकर", "பாதுகாப்பான, உறுதியான சமூகங்களுக்காக ஒன்றாக", "സുരക്ഷിതവും കരുത്തുറ്റതുമായ സമൂഹങ്ങൾക്കായി ഒന്നിച്ച്", "ಸುರಕ್ಷಿತ, ಸದೃಢ ಸಮುದಾಯಗಳಿಗಾಗಿ ಒಟ್ಟಾಗಿ"],
    ["Mobile number", "मोबाइल नंबर", "கைபேசி எண்", "മൊബൈൽ നമ്പർ", "ಮೊಬೈಲ್ ಸಂಖ್ಯೆ"],
    ["Password", "पासवर्ड", "கடவுச்சொல்", "പാസ്‌വേഡ്", "ಪಾಸ್‌ವರ್ಡ್"],
    ["Enter 4-digit MPIN", "4 अंकों का MPIN दर्ज करें", "4 இலக்க MPIN-ஐ உள்ளிடுக", "4 അക്ക MPIN നൽകുക", "4 ಅಂಕಿಯ MPIN ನಮೂದಿಸಿ"],
    ["Remember me", "मुझे याद रखें", "என்னை நினைவில் கொள்க", "എന്നെ ഓർക്കുക", "ನನ್ನನ್ನು ನೆನಪಿಡಿ"],
    ["Forgot password?", "पासवर्ड भूल गए?", "கடவுச்சொல் மறந்துவிட்டதா?", "പാസ്‌വേഡ് മറന്നോ?", "ಪಾಸ್‌ವರ್ಡ್ ಮರೆತಿರಾ?"],
    ["Forgot MPIN?", "MPIN भूल गए?", "MPIN மறந்துவிட்டதா?", "MPIN മറന്നോ?", "MPIN ಮರೆತಿರಾ?"],
    ["Forgot password", "पासवर्ड भूल गए", "கடவுச்சொல் மறந்தது", "പാസ്‌വേഡ് മറന്നു", "ಪಾಸ್‌ವರ್ಡ್ ಮರೆತಿದೆ"],
    ["Sign In", "साइन इन करें", "உள்நுழைக", "സൈൻ ഇൻ", "ಸೈನ್ ಇನ್"],
    ["Sign in", "साइन इन करें", "உள்நுழைக", "സൈൻ ഇൻ", "ಸೈನ್ ಇನ್"],
    ["New user?", "नए उपयोगकर्ता?", "புதிய பயனரா?", "പുതിയ ഉപയോക്താവാണോ?", "ಹೊಸ ಬಳಕೆದಾರರೇ?"],
    ["or", "या", "அல்லது", "അല്ലെങ്കിൽ", "ಅಥವಾ"],
    ["Register now", "अभी पंजीकरण करें", "இப்போது பதிவு செய்க", "ഇപ്പോൾ രജിസ്റ്റർ ചെയ്യുക", "ಈಗ ನೋಂದಾಯಿಸಿ"],
    ["Need help?", "सहायता चाहिए?", "உதவி வேண்டுமா?", "സഹായം വേണോ?", "ಸಹಾಯ ಬೇಕೇ?"],
    ["Contact support", "सहायता से संपर्क करें", "உதவியைத் தொடர்புகொள்க", "പിന്തുണയുമായി ബന്ധപ്പെടുക", "ಬೆಂಬಲವನ್ನು ಸಂಪರ್ಕಿಸಿ"],
    ["Staff or field team? Sign in with ASHRAAY SSO", "स्टाफ़ या फ़ील्ड टीम? ASHRAAY SSO से साइन इन करें", "பணியாளர் அல்லது களக் குழுவா? ASHRAAY SSO மூலம் உள்நுழைக", "സ്റ്റാഫോ ഫീൽഡ് ടീമോ? ASHRAAY SSO ഉപയോഗിച്ച് സൈൻ ഇൻ ചെയ്യുക", "ಸಿಬ್ಬಂದಿ ಅಥವಾ ಕ್ಷೇತ್ರ ತಂಡವೇ? ASHRAAY SSO ಮೂಲಕ ಸೈನ್ ಇನ್ ಮಾಡಿ"],
    ["Create your account", "अपना खाता बनाएँ", "உங்கள் கணக்கை உருவாக்குக", "നിങ്ങളുടെ അക്കൗണ്ട് സൃഷ്ടിക്കുക", "ನಿಮ್ಮ ಖಾತೆ ರಚಿಸಿ"],
    ["Register with your mobile number and email.", "अपने मोबाइल नंबर और ईमेल से पंजीकरण करें।", "உங்கள் கைபேசி எண் மற்றும் மின்னஞ்சலுடன் பதிவு செய்க.", "നിങ്ങളുടെ മൊബൈൽ നമ്പറും ഇമെയിലും ഉപയോഗിച്ച് രജിസ്റ്റർ ചെയ്യുക.", "ನಿಮ್ಮ ಮೊಬೈಲ್ ಸಂಖ್ಯೆ ಮತ್ತು ಇಮೇಲ್‌ನೊಂದಿಗೆ ನೋಂದಾಯಿಸಿ."],
    ["Report flooding, check in safe and get approved alerts.", "बाढ़ की रिपोर्ट करें, सुरक्षित होने की सूचना दें और स्वीकृत चेतावनियाँ पाएँ।", "வெள்ளத்தைப் புகாரளிக்கவும், பாதுகாப்பைப் பதிவு செய்யவும், அங்கீகரித்த எச்சரிக்கைகளைப் பெறவும்.", "വെള്ളപ്പൊക്കം റിപ്പോർട്ട് ചെയ്യുക, സുരക്ഷിതമെന്ന് അറിയിക്കുക, അംഗീകൃത മുന്നറിയിപ്പുകൾ നേടുക.", "ಪ್ರವಾಹ ವರದಿ ಮಾಡಿ, ಸುರಕ್ಷಿತವೆಂದು ತಿಳಿಸಿ ಮತ್ತು ಅನುಮೋದಿತ ಎಚ್ಚರಿಕೆಗಳನ್ನು ಪಡೆಯಿರಿ."],
    ["Verified volunteers: see approved tasks that match your skills.", "सत्यापित स्वयंसेवक: अपने कौशल से मेल खाते स्वीकृत कार्य देखें।", "சரிபார்த்த தன்னார்வலர்கள்: உங்கள் திறன்களுக்கு ஏற்ற அங்கீகரித்த பணிகளைக் காண்க.", "പരിശോധിച്ച സന്നദ്ധസേവകർ: നിങ്ങളുടെ കഴിവുകൾക്കിണങ്ങിയ അംഗീകൃത ജോലികൾ കാണുക.", "ಪರಿಶೀಲಿತ ಸ್ವಯಂಸೇವಕರು: ನಿಮ್ಮ ಕೌಶಲ್ಯಕ್ಕೆ ಹೊಂದುವ ಅನುಮೋದಿತ ಕಾರ್ಯಗಳನ್ನು ನೋಡಿ."],
    ["Email", "ईमेल", "மின்னஞ்சல்", "ഇമെയിൽ", "ಇಮೇಲ್"],
    ["Full name", "पूरा नाम", "முழுப் பெயர்", "പൂർണ്ണമായ പേര്", "ಪೂರ್ಣ ಹೆಸರು"],
    ["Confirm password", "पासवर्ड की पुष्टि करें", "கடவுச்சொல்லை உறுதிப்படுத்துக", "പാസ്‌വേഡ് സ്ഥിരീകരിക്കുക", "ಪಾಸ್‌ವರ್ಡ್ ದೃಢಪಡಿಸಿ"],
    ["4-digit MPIN (optional, for quick sign-in)", "4 अंकों का MPIN (वैकल्पिक, त्वरित साइन-इन के लिए)", "4 இலக்க MPIN (விருப்பத்தேர்வு, விரைவு உள்நுழைவுக்கு)", "4 അക്ക MPIN (ഐച്ഛികം, വേഗത്തിലുള്ള സൈൻ ഇന്നിന്)", "4 ಅಂಕಿಯ MPIN (ಐಚ್ಛಿಕ, ತ್ವರಿತ ಸೈನ್ ಇನ್‌ಗಾಗಿ)"],
    ["Create account", "खाता बनाएँ", "கணக்கை உருவாக்குக", "അക്കൗണ്ട് സൃഷ്ടിക്കുക", "ಖಾತೆ ರಚಿಸಿ"],
    ["Creating account…", "खाता बनाया जा रहा है…", "கணக்கு உருவாக்கப்படுகிறது…", "അക്കൗണ്ട് സൃഷ്ടിക്കുന്നു…", "ಖಾತೆ ರಚಿಸಲಾಗುತ್ತಿದೆ…"],
    ["Already registered?", "पहले से पंजीकृत?", "ஏற்கனவே பதிவு செய்துள்ளீர்களா?", "ഇതിനകം രജിസ്റ്റർ ചെയ്തോ?", "ಈಗಾಗಲೇ ನೋಂದಾಯಿಸಿದ್ದೀರಾ?"],
    ["Reset your password", "अपना पासवर्ड रीसेट करें", "உங்கள் கடவுச்சொல்லை மீட்டமைக்கவும்", "നിങ്ങളുടെ പാസ്‌വേഡ് പുനഃസജ്ജമാക്കുക", "ನಿಮ್ಮ ಪಾಸ್‌ವರ್ಡ್ ಮರುಹೊಂದಿಸಿ"],
    ["Enter your registered mobile number or email to get a 6-digit reset code.", "6 अंकों का रीसेट कोड पाने के लिए अपना पंजीकृत मोबाइल नंबर या ईमेल दर्ज करें।", "6 இலக்க மீட்டமைப்புக் குறியீட்டைப் பெற உங்கள் பதிவு செய்த கைபேசி எண் அல்லது மின்னஞ்சலை உள்ளிடுக.", "6 അക്ക റീസെറ്റ് കോഡ് ലഭിക്കാൻ നിങ്ങളുടെ രജിസ്റ്റർ ചെയ്ത മൊബൈൽ നമ്പറോ ഇമെയിലോ നൽകുക.", "6 ಅಂಕಿಯ ಮರುಹೊಂದಿಕೆ ಕೋಡ್ ಪಡೆಯಲು ನಿಮ್ಮ ನೋಂದಾಯಿತ ಮೊಬೈಲ್ ಸಂಖ್ಯೆ ಅಥವಾ ಇಮೇಲ್ ನಮೂದಿಸಿ."],
    ["Mobile number or email", "मोबाइल नंबर या ईमेल", "கைபேசி எண் அல்லது மின்னஞ்சல்", "മൊബൈൽ നമ്പർ അല്ലെങ്കിൽ ഇമെയിൽ", "ಮೊಬೈಲ್ ಸಂಖ್ಯೆ ಅಥವಾ ಇಮೇಲ್"],
    ["Send reset code", "रीसेट कोड भेजें", "மீட்டமைப்புக் குறியீட்டை அனுப்புக", "റീസെറ്റ് കോഡ് അയയ്ക്കുക", "ಮರುಹೊಂದಿಕೆ ಕೋಡ್ ಕಳುಹಿಸಿ"],
    ["Sending…", "भेजा जा रहा है…", "அனுப்பப்படுகிறது…", "അയയ്ക്കുന്നു…", "ಕಳುಹಿಸಲಾಗುತ್ತಿದೆ…"],
    ["6-digit reset code", "6 अंकों का रीसेट कोड", "6 இலக்க மீட்டமைப்புக் குறியீடு", "6 അക്ക റീസെറ്റ് കോഡ്", "6 ಅಂಕಿಯ ಮರುಹೊಂದಿಕೆ ಕೋಡ್"],
    ["Reset code", "रीसेट कोड", "மீட்டமைப்புக் குறியீடு", "റീസെറ്റ് കോഡ്", "ಮರುಹೊಂದಿಕೆ ಕೋಡ್"],
    ["New password", "नया पासवर्ड", "புதிய கடவுச்சொல்", "പുതിയ പാസ്‌വേഡ്", "ಹೊಸ ಪಾಸ್‌ವರ್ಡ್"],
    ["New 4-digit MPIN (optional)", "नया 4 अंकों का MPIN (वैकल्पिक)", "புதிய 4 இலக்க MPIN (விருப்பத்தேர்வு)", "പുതിയ 4 അക്ക MPIN (ഐച്ഛികം)", "ಹೊಸ 4 ಅಂಕಿಯ MPIN (ಐಚ್ಛಿಕ)"],
    ["Reset password", "पासवर्ड रीसेट करें", "கடவுச்சொல்லை மீட்டமைக்கவும்", "പാസ്‌വേഡ് പുനഃസജ്ജമാക്കുക", "ಪಾಸ್‌ವರ್ಡ್ ಮರುಹೊಂದಿಸಿ"],
    ["Resetting…", "रीसेट हो रहा है…", "மீட்டமைக்கப்படுகிறது…", "പുനഃസജ്ജമാക്കുന്നു…", "ಮರುಹೊಂದಿಸಲಾಗುತ್ತಿದೆ…"],
    ["Back to sign in", "साइन इन पर वापस जाएँ", "உள்நுழைவுக்குத் திரும்புக", "സൈൻ ഇന്നിലേക്ക് മടങ്ങുക", "ಸೈನ್ ಇನ್‌ಗೆ ಹಿಂತಿರುಗಿ"],
    ["Disaster Management Authority", "आपदा प्रबंधन प्राधिकरण", "பேரிடர் மேலாண்மை ஆணையம்", "ദുരന്ത നിവാരണ അതോറിറ്റി", "ವಿಪತ್ತು ನಿರ್ವಹಣಾ ಪ್ರಾಧಿಕಾರ"],
    ["Privacy Policy", "गोपनीयता नीति", "தனியுரிமைக் கொள்கை", "സ്വകാര്യതാ നയം", "ಗೌಪ್ಯತಾ ನೀತಿ"],
    ["Terms of Use", "उपयोग की शर्तें", "பயன்பாட்டு விதிமுறைகள்", "ഉപയോഗ നിബന്ധനകൾ", "ಬಳಕೆಯ ನಿಯಮಗಳು"],
    ["Show password", "पासवर्ड दिखाएँ", "கடவுச்சொல்லைக் காட்டு", "പാസ്‌വേഡ് കാണിക്കുക", "ಪಾಸ್‌ವರ್ಡ್ ತೋರಿಸಿ"],
    ["Hide password", "पासवर्ड छिपाएँ", "கடவுச்சொல்லை மறை", "പാസ്‌വേഡ് മറയ്ക്കുക", "ಪಾಸ್‌ವರ್ಡ್ ಮರೆಮಾಡಿ"],
    ["Backspace", "मिटाएँ", "அழி", "മായ്ക്കുക", "ಅಳಿಸಿ"],
    ["Enter a valid 10-digit mobile number.", "मान्य 10 अंकों का मोबाइल नंबर दर्ज करें।", "சரியான 10 இலக்க கைபேசி எண்ணை உள்ளிடுக.", "സാധുവായ 10 അക്ക മൊബൈൽ നമ്പർ നൽകുക.", "ಮಾನ್ಯ 10 ಅಂಕಿಯ ಮೊಬೈಲ್ ಸಂಖ್ಯೆ ನಮೂದಿಸಿ."],
    ["Password must be at least 8 characters.", "पासवर्ड कम से कम 8 अक्षरों का होना चाहिए।", "கடவுச்சொல் குறைந்தது 8 எழுத்துகள் இருக்க வேண்டும்.", "പാസ്‌വേഡിന് കുറഞ്ഞത് 8 അക്ഷരങ്ങൾ വേണം.", "ಪಾಸ್‌ವರ್ಡ್ ಕನಿಷ್ಠ 8 ಅಕ್ಷರಗಳಿರಬೇಕು."],
    ["Enter all 4 digits of your MPIN.", "अपने MPIN के सभी 4 अंक दर्ज करें।", "உங்கள் MPIN-இன் 4 இலக்கங்களையும் உள்ளிடுக.", "നിങ്ങളുടെ MPIN-ന്റെ 4 അക്കങ്ങളും നൽകുക.", "ನಿಮ್ಮ MPIN ನ ಎಲ್ಲಾ 4 ಅಂಕಿಗಳನ್ನು ನಮೂದಿಸಿ."],
    ["Enter a valid email address.", "मान्य ईमेल पता दर्ज करें।", "சரியான மின்னஞ்சல் முகவரியை உள்ளிடுக.", "സാധുവായ ഇമെയിൽ വിലാസം നൽകുക.", "ಮಾನ್ಯ ಇಮೇಲ್ ವಿಳಾಸ ನಮೂದಿಸಿ."],
    ["Passwords do not match.", "पासवर्ड मेल नहीं खाते।", "கடவுச்சொற்கள் பொருந்தவில்லை.", "പാസ്‌വേഡുകൾ പൊരുത്തപ്പെടുന്നില്ല.", "ಪಾಸ್‌ವರ್ಡ್‌ಗಳು ಹೊಂದುತ್ತಿಲ್ಲ."],
    ["MPIN must be exactly 4 digits.", "MPIN ठीक 4 अंकों का होना चाहिए।", "MPIN சரியாக 4 இலக்கங்கள் இருக்க வேண்டும்.", "MPIN കൃത്യം 4 അക്കങ്ങളായിരിക്കണം.", "MPIN ನಿಖರವಾಗಿ 4 ಅಂಕಿಗಳಿರಬೇಕು."],
    ["Enter your registered mobile number or email.", "अपना पंजीकृत मोबाइल नंबर या ईमेल दर्ज करें।", "உங்கள் பதிவு செய்த கைபேசி எண் அல்லது மின்னஞ்சலை உள்ளிடுக.", "നിങ്ങളുടെ രജിസ്റ്റർ ചെയ്ത മൊബൈൽ നമ്പറോ ഇമെയിലോ നൽകുക.", "ನಿಮ್ಮ ನೋಂದಾಯಿತ ಮೊಬೈಲ್ ಸಂಖ್ಯೆ ಅಥವಾ ಇಮೇಲ್ ನಮೂದಿಸಿ."],
    ["Enter the 6-digit reset code.", "6 अंकों का रीसेट कोड दर्ज करें।", "6 இலக்க மீட்டமைப்புக் குறியீட்டை உள்ளிடுக.", "6 അക്ക റീസെറ്റ് കോഡ് നൽകുക.", "6 ಅಂಕಿಯ ಮರುಹೊಂದಿಕೆ ಕೋಡ್ ನಮೂದಿಸಿ."],
    ["Cannot reach the ASHRAAY server. Check your connection.", "ASHRAAY सर्वर तक नहीं पहुँच सके। अपना कनेक्शन जाँचें।", "ASHRAAY சேவையகத்தை அணுக முடியவில்லை. உங்கள் இணைப்பைச் சரிபார்க்கவும்.", "ASHRAAY സെർവറിൽ എത്താനാവുന്നില്ല. നിങ്ങളുടെ കണക്ഷൻ പരിശോധിക്കുക.", "ASHRAAY ಸರ್ವರ್ ತಲುಪಲಾಗುತ್ತಿಲ್ಲ. ನಿಮ್ಮ ಸಂಪರ್ಕ ಪರಿಶೀಲಿಸಿ."],
    ["Support: call the district control room, or 112 in an emergency.", "सहायता: ज़िला नियंत्रण कक्ष को कॉल करें, या आपात स्थिति में 112।", "உதவி: மாவட்டக் கட்டுப்பாட்டு அறையை அழைக்கவும், அவசரத்தில் 112.", "സഹായം: ജില്ലാ കൺട്രോൾ റൂമിൽ വിളിക്കുക, അടിയന്തര ഘട്ടത്തിൽ 112.", "ಸಹಾಯ: ಜಿಲ್ಲಾ ನಿಯಂತ್ರಣ ಕೊಠಡಿಗೆ ಕರೆ ಮಾಡಿ, ತುರ್ತು ಸಂದರ್ಭದಲ್ಲಿ 112."],
    // Server responses shown on these screens.
    ["Mobile number or password/MPIN is incorrect.", "मोबाइल नंबर या पासवर्ड/MPIN गलत है।", "கைபேசி எண் அல்லது கடவுச்சொல்/MPIN தவறானது.", "മൊബൈൽ നമ്പറോ പാസ്‌വേഡ്/MPIN-ഓ തെറ്റാണ്.", "ಮೊಬೈಲ್ ಸಂಖ್ಯೆ ಅಥವಾ ಪಾಸ್‌ವರ್ಡ್/MPIN ತಪ್ಪಾಗಿದೆ."],
    ["If an account matches, a 6-digit reset code has been issued. It expires in 10 minutes.", "यदि कोई खाता मेल खाता है, तो 6 अंकों का रीसेट कोड जारी किया गया है। यह 10 मिनट में समाप्त होगा।", "கணக்கு பொருந்தினால், 6 இலக்க மீட்டமைப்புக் குறியீடு வழங்கப்பட்டது. அது 10 நிமிடங்களில் காலாவதியாகும்.", "അക്കൗണ്ട് പൊരുത്തപ്പെട്ടാൽ 6 അക്ക റീസെറ്റ് കോഡ് നൽകിയിട്ടുണ്ട്. 10 മിനിറ്റിൽ അത് കാലഹരണപ്പെടും.", "ಖಾತೆ ಹೊಂದಿಕೆಯಾದರೆ, 6 ಅಂಕಿಯ ಮರುಹೊಂದಿಕೆ ಕೋಡ್ ನೀಡಲಾಗಿದೆ. ಇದು 10 ನಿಮಿಷಗಳಲ್ಲಿ ಅವಧಿ ಮೀರುತ್ತದೆ."],
    ["Your password has been reset. Sign in with your new details.", "आपका पासवर्ड रीसेट हो गया है। नए विवरण से साइन इन करें।", "உங்கள் கடவுச்சொல் மீட்டமைக்கப்பட்டது. புதிய விவரங்களுடன் உள்நுழைக.", "നിങ്ങളുടെ പാസ്‌വേഡ് പുനഃസജ്ജമാക്കി. പുതിയ വിവരങ്ങൾ ഉപയോഗിച്ച് സൈൻ ഇൻ ചെയ്യുക.", "ನಿಮ್ಮ ಪಾಸ್‌ವರ್ಡ್ ಮರುಹೊಂದಿಸಲಾಗಿದೆ. ಹೊಸ ವಿವರಗಳೊಂದಿಗೆ ಸೈನ್ ಇನ್ ಮಾಡಿ."],
    ["The reset code is invalid or has expired. Request a new code.", "रीसेट कोड अमान्य है या समाप्त हो गया है। नया कोड माँगें।", "மீட்டமைப்புக் குறியீடு தவறானது அல்லது காலாவதியானது. புதிய குறியீட்டைக் கோருக.", "റീസെറ്റ് കോഡ് അസാധുവാണ് അല്ലെങ്കിൽ കാലഹരണപ്പെട്ടു. പുതിയ കോഡ് ആവശ്യപ്പെടുക.", "ಮರುಹೊಂದಿಕೆ ಕೋಡ್ ಅಮಾನ್ಯ ಅಥವಾ ಅವಧಿ ಮೀರಿದೆ. ಹೊಸ ಕೋಡ್ ವಿನಂತಿಸಿ."],
    ["This mobile number is already registered. Sign in instead.", "यह मोबाइल नंबर पहले से पंजीकृत है। इसके बजाय साइन इन करें।", "இந்தக் கைபேசி எண் ஏற்கனவே பதிவு செய்யப்பட்டுள்ளது. உள்நுழையவும்.", "ഈ മൊബൈൽ നമ്പർ ഇതിനകം രജിസ്റ്റർ ചെയ്തിട്ടുണ്ട്. പകരം സൈൻ ഇൻ ചെയ്യുക.", "ಈ ಮೊಬೈಲ್ ಸಂಖ್ಯೆ ಈಗಾಗಲೇ ನೋಂದಾಯಿತವಾಗಿದೆ. ಬದಲಿಗೆ ಸೈನ್ ಇನ್ ಮಾಡಿ."],
    ["This email is already registered. Sign in instead.", "यह ईमेल पहले से पंजीकृत है। इसके बजाय साइन इन करें।", "இந்த மின்னஞ்சல் ஏற்கனவே பதிவு செய்யப்பட்டுள்ளது. உள்நுழையவும்.", "ഈ ഇമെയിൽ ഇതിനകം രജിസ്റ്റർ ചെയ്തിട്ടുണ്ട്. പകരം സൈൻ ഇൻ ചെയ്യുക.", "ಈ ಇಮೇಲ್ ಈಗಾಗಲೇ ನೋಂದಾಯಿತವಾಗಿದೆ. ಬದಲಿಗೆ ಸೈನ್ ಇನ್ ಮಾಡಿ."],
    ["Too many failed attempts. Try again in 15 minutes or reset your password.", "बहुत अधिक असफल प्रयास। 15 मिनट बाद पुनः प्रयास करें या पासवर्ड रीसेट करें।", "பல தோல்வியுற்ற முயற்சிகள். 15 நிமிடங்களில் மீண்டும் முயலவும் அல்லது கடவுச்சொல்லை மீட்டமைக்கவும்.", "നിരവധി പരാജയപ്പെട്ട ശ്രമങ്ങൾ. 15 മിനിറ്റിനു ശേഷം വീണ്ടും ശ്രമിക്കുക അല്ലെങ്കിൽ പാസ്‌വേഡ് പുനഃസജ്ജമാക്കുക.", "ಹಲವು ವಿಫಲ ಪ್ರಯತ್ನಗಳು. 15 ನಿಮಿಷಗಳ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ ಅಥವಾ ಪಾಸ್‌ವರ್ಡ್ ಮರುಹೊಂದಿಸಿ."],
    ["No MPIN is set for this account. Sign in with your password.", "इस खाते के लिए कोई MPIN सेट नहीं है। पासवर्ड से साइन इन करें।", "இந்தக் கணக்கிற்கு MPIN அமைக்கப்படவில்லை. கடவுச்சொல்லுடன் உள்நுழைக.", "ഈ അക്കൗണ്ടിന് MPIN സജ്ജമാക്കിയിട്ടില്ല. പാസ്‌വേഡ് ഉപയോഗിച്ച് സൈൻ ഇൻ ചെയ്യുക.", "ಈ ಖಾತೆಗೆ MPIN ಹೊಂದಿಸಿಲ್ಲ. ಪಾಸ್‌ವರ್ಡ್‌ನೊಂದಿಗೆ ಸೈನ್ ಇನ್ ಮಾಡಿ."],
    ["This account is registered as a Citizen. Choose the Citizen tab to sign in.", "यह खाता नागरिक के रूप में पंजीकृत है। साइन इन के लिए नागरिक टैब चुनें।", "இந்தக் கணக்கு குடிமகனாகப் பதிவு செய்யப்பட்டுள்ளது. உள்நுழைய குடிமகன் தாவலைத் தேர்ந்தெடுக்கவும்.", "ഈ അക്കൗണ്ട് പൗരനായി രജിസ്റ്റർ ചെയ്തതാണ്. സൈൻ ഇൻ ചെയ്യാൻ പൗരൻ ടാബ് തിരഞ്ഞെടുക്കുക.", "ಈ ಖಾತೆ ನಾಗರಿಕರಾಗಿ ನೋಂದಾಯಿತವಾಗಿದೆ. ಸೈನ್ ಇನ್ ಮಾಡಲು ನಾಗರಿಕ ಟ್ಯಾಬ್ ಆಯ್ಕೆಮಾಡಿ."],
    ["This account is registered as a Volunteer. Choose the Volunteer tab to sign in.", "यह खाता स्वयंसेवक के रूप में पंजीकृत है। साइन इन के लिए स्वयंसेवक टैब चुनें।", "இந்தக் கணக்கு தன்னார்வலராகப் பதிவு செய்யப்பட்டுள்ளது. உள்நுழைய தன்னார்வலர் தாவலைத் தேர்ந்தெடுக்கவும்.", "ഈ അക്കൗണ്ട് സന്നദ്ധസേവകനായി രജിസ്റ്റർ ചെയ്തതാണ്. സൈൻ ഇൻ ചെയ്യാൻ സന്നദ്ധസേവകൻ ടാബ് തിരഞ്ഞെടുക്കുക.", "ಈ ಖಾತೆ ಸ್ವಯಂಸೇವಕರಾಗಿ ನೋಂದಾಯಿತವಾಗಿದೆ. ಸೈನ್ ಇನ್ ಮಾಡಲು ಸ್ವಯಂಸೇವಕ ಟ್ಯಾಬ್ ಆಯ್ಕೆಮಾಡಿ."],
    ["This account is registered as a Staff. Choose the Staff tab to sign in.", "यह खाता स्टाफ़ के रूप में पंजीकृत है। साइन इन के लिए स्टाफ़ टैब चुनें।", "இந்தக் கணக்கு பணியாளராகப் பதிவு செய்யப்பட்டுள்ளது. உள்நுழைய பணியாளர் தாவலைத் தேர்ந்தெடுக்கவும்.", "ഈ അക്കൗണ്ട് സ്റ്റാഫായി രജിസ്റ്റർ ചെയ്തതാണ്. സൈൻ ഇൻ ചെയ്യാൻ സ്റ്റാഫ് ടാബ് തിരഞ്ഞെടുക്കുക.", "ಈ ಖಾತೆ ಸಿಬ್ಬಂದಿಯಾಗಿ ನೋಂದಾಯಿತವಾಗಿದೆ. ಸೈನ್ ಇನ್ ಮಾಡಲು ಸಿಬ್ಬಂದಿ ಟ್ಯಾಬ್ ಆಯ್ಕೆಮಾಡಿ."]
  ];
  const loginAdditions = { hi: {}, ta: {}, ml: {}, kn: {} };
  for (const [english, ...translations] of LOGIN_PHRASES) {
    ["hi", "ta", "ml", "kn"].forEach((language, index) => { loginAdditions[language][english] = translations[index]; });
  }
  global.ashraayI18n.extend(loginAdditions);

  function init({ onSignedIn, onSso }) {
    const auth = global.ashraayAuth;
    const t = global.ashraayI18n.t;
    const state = { role: "citizen", registerRole: "citizen", method: "password", resetIdentifier: "" };

    const setText = (element, key) => {
      if (!element) return;
      element.dataset.i18n = key;
      element.textContent = t(key);
    };
    const fieldError = (id, message) => {
      document.querySelector(`[data-box="${id}"]`)?.classList.toggle("err", Boolean(message));
      const slot = document.querySelector(`[data-msg="${id}"]`);
      if (slot) slot.textContent = message ? t(message) : "";
      return message ? $(id) : null;
    };
    const busy = (button, on, label) => {
      button.disabled = on;
      const span = button.querySelector("span");
      if (on) { span.dataset.idle = span.dataset.i18n; span.textContent = t(label); }
      else if (span.dataset.idle) setText(span, span.dataset.idle);
    };

    let toastTimer;
    const toast = (message) => {
      $("login-toast").textContent = message;
      $("login-toast").classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => $("login-toast").classList.remove("show"), 3600);
    };

    function showView(name) {
      ["signin", "register", "forgot"].forEach((view) => $(`login-${view}-view`).classList.toggle("hidden", view !== name));
      setText(document.querySelector("#login-screen .lg-title"),
        { signin: "Sign in to ASHRAAY", register: "Register with ASHRAAY", forgot: "Forgot password" }[name]);
      if (name === "forgot") {
        $("forgot-form").classList.remove("hidden");
        $("reset-form").classList.add("hidden");
        $("reset-info").innerHTML = "";
        $("forgot-error").textContent = "";
      }
      const focus = { signin: "login-phone", register: "register-phone", forgot: "forgot-identifier" }[name];
      $(focus).focus();
    }
    document.querySelectorAll("#login-screen [data-login-view]").forEach((link) => {
      link.addEventListener("click", (event) => { event.preventDefault(); showView(link.dataset.loginView); });
    });

    function bindRoleTabs(selector, hintId, onChange, defaultRole) {
      const buttons = [...document.querySelectorAll(`${selector} button`)];
      buttons.forEach((button) => button.addEventListener("click", () => {
        buttons.forEach((other) => other.setAttribute("aria-selected", String(other === button)));
        setText($(hintId), ROLE_HINTS[button.dataset.role]);
        onChange(button.dataset.role);
      }));
      // Honor whichever tab is pre-marked selected in the markup (falls back to the first tab, then to
      // defaultRole when the tab bar has been removed from the page, e.g. the Command Center's staff-only sign-in).
      const initial = buttons.find((button) => button.getAttribute("aria-selected") === "true") || buttons[0];
      if (initial) { setText($(hintId), ROLE_HINTS[initial.dataset.role]); onChange(initial.dataset.role); }
      else if (defaultRole) onChange(defaultRole);
    }
    const signinDefaultRole = $("login-signin-view")?.dataset.defaultRole;
    bindRoleTabs(".login-roles", "login-role-hint", (role) => { state.role = role; }, signinDefaultRole);
    bindRoleTabs(".register-roles", "register-role-hint", (role) => { state.registerRole = role; });

    // Digits-only inputs.
    [["login-phone", 10], ["register-phone", 10], ["register-mpin", 4], ["reset-mpin", 4], ["reset-code", 6]].forEach(([id, max]) => {
      $(id).addEventListener("input", function () {
        this.value = this.value.replace(/\D/g, "").slice(0, max);
        fieldError(id, "");
      });
    });
    ["register-email", "register-password", "register-confirm", "forgot-identifier", "reset-password", "reset-confirm"].forEach((id) => {
      $(id).addEventListener("input", () => fieldError(id, ""));
    });

    const eye = (button, field) => button.addEventListener("click", () => {
      const show = field.type === "password";
      field.type = show ? "text" : "password";
      button.setAttribute("aria-pressed", String(show));
      button.setAttribute("aria-label", t(show ? "Hide password" : "Show password"));
    });
    eye($("login-eye"), $("login-password"));
    document.querySelectorAll("#login-screen [data-eye]").forEach((button) => eye(button, $(button.dataset.eye)));

    // ---------- sign in ----------
    const pinWrap = $("login-pin-boxes");
    for (let i = 0; i < 4; i++) {
      const box = document.createElement("input");
      box.type = "password"; box.inputMode = "numeric"; box.maxLength = 1; box.autocomplete = "off";
      box.setAttribute("aria-label", `MPIN digit ${i + 1}`);
      pinWrap.appendChild(box);
    }
    const pin = [...pinWrap.querySelectorAll("input")];
    const clearPinError = () => { pinWrap.classList.remove("err"); $("login-pin-msg").textContent = ""; };
    const fillPin = (value, start) => {
      for (let j = 0; j < value.length && start + j < 4; j++) pin[start + j].value = value[j];
      pin[Math.min(start + value.length, 3)].focus();
    };
    pin.forEach((box, index) => {
      box.addEventListener("input", () => {
        const digits = box.value.replace(/\D/g, "");
        if (digits.length > 1) { fillPin(digits, index); return; }
        box.value = digits;
        clearPinError();
        if (digits && index < 3) pin[index + 1].focus();
      });
      box.addEventListener("keydown", (event) => {
        if (event.key === "Backspace" && !box.value && index > 0) { pin[index - 1].focus(); pin[index - 1].value = ""; }
      });
      box.addEventListener("paste", (event) => {
        event.preventDefault();
        fillPin(event.clipboardData.getData("text").replace(/\D/g, ""), index);
      });
    });

    document.querySelectorAll(".login-method button").forEach((button) => {
      button.addEventListener("click", () => {
        state.method = button.dataset.method;
        document.querySelectorAll(".login-method button").forEach((other) => other.setAttribute("aria-checked", String(other === button)));
        const isMpin = state.method === "mpin";
        $("login-pwd-field").classList.toggle("hidden", isMpin);
        $("login-pin-field").classList.toggle("hidden", !isMpin);
        setText($("login-forgot"), isMpin ? "Forgot MPIN?" : "Forgot password?");
        (isMpin ? pin[0] : $("login-password")).focus();
      });
    });
    $("login-password").addEventListener("input", () => {
      $("login-pwd-box").classList.remove("err"); $("login-pwd-msg").textContent = "";
    });
    $("login-phone").addEventListener("input", () => {
      $("login-phone-box").classList.remove("err"); $("login-phone-msg").textContent = "";
    });

    $("login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      $("login-error").textContent = "";
      let firstInvalid = null;
      const phone = $("login-phone").value;
      const phoneBad = !PHONE_RE.test(phone);
      $("login-phone-box").classList.toggle("err", phoneBad);
      $("login-phone-msg").textContent = phoneBad ? t("Enter a valid 10-digit mobile number.") : "";
      if (phoneBad) firstInvalid = $("login-phone");
      const password = $("login-password").value;
      const mpin = pin.map((box) => box.value).join("");
      if (state.method === "password") {
        const bad = password.length < 8;
        $("login-pwd-box").classList.toggle("err", bad);
        $("login-pwd-msg").textContent = bad ? t("Password must be at least 8 characters.") : "";
        if (bad) firstInvalid = firstInvalid || $("login-password");
      } else if (!/^\d{4}$/.test(mpin)) {
        pinWrap.classList.add("err");
        $("login-pin-msg").textContent = t("Enter all 4 digits of your MPIN.");
        firstInvalid = firstInvalid || pin.find((box) => !box.value) || pin[0];
      }
      if (firstInvalid) { firstInvalid.focus(); return; }
      busy($("login-signin"), true, "Signing in…");
      try {
        await auth.signIn({
          role: state.role,
          phone,
          password: state.method === "password" ? password : null,
          mpin: state.method === "mpin" ? mpin : null,
          remember: $("login-remember").checked
        });
        $("login-password").value = "";
        pin.forEach((box) => { box.value = ""; });
        onSignedIn();
      } catch (error) {
        $("login-error").textContent = error instanceof TypeError ? t("Cannot reach the ASHRAAY server. Check your connection.") : t(error.message);
      } finally {
        busy($("login-signin"), false);
      }
    });

    $("login-forgot").addEventListener("click", (event) => {
      event.preventDefault();
      showView("forgot");
      if (PHONE_RE.test($("login-phone").value)) $("forgot-identifier").value = $("login-phone").value;
    });
    $("login-register")?.addEventListener("click", () => {
      const tab = document.querySelector(`.register-roles button[data-role="${state.role}"]`)
        || document.querySelector(".register-roles button");
      tab.click();
      showView("register");
    });
    $("login-support").addEventListener("click", (event) => {
      event.preventDefault();
      toast(t("Support: call the district control room, or 112 in an emergency."));
    });
    $("login-sso")?.addEventListener("click", (event) => {
      event.preventDefault();
      (onSso || onSignedIn)();
    });

    // ---------- register ----------
    let registerLocation = null;
    const canUseGps = () => Boolean(navigator.geolocation) && window.isSecureContext;
    $("register-locate")?.addEventListener("click", () => {
      if (!canUseGps()) {
        $("register-location-status").textContent = t("GPS needs a secure (HTTPS) connection.");
        return;
      }
      $("register-location-status").textContent = t("Finding your location…");
      navigator.geolocation.getCurrentPosition((position) => {
        registerLocation = {
          latitude: Number(position.coords.latitude.toFixed(6)),
          longitude: Number(position.coords.longitude.toFixed(6))
        };
        $("register-location-status").textContent = t("Location saved.");
      }, () => {
        registerLocation = null;
        $("register-location-status").textContent = t("Location not available. You can still register without it.");
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    });
    $("register-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      $("register-error").textContent = "";
      const values = {
        phone: $("register-phone").value,
        email: $("register-email").value.trim(),
        password: $("register-password").value,
        confirm: $("register-confirm").value,
        mpin: $("register-mpin").value
      };
      const invalid = [
        fieldError("register-phone", PHONE_RE.test(values.phone) ? "" : "Enter a valid 10-digit mobile number."),
        fieldError("register-email", EMAIL_RE.test(values.email) ? "" : "Enter a valid email address."),
        fieldError("register-password", values.password.length >= 8 ? "" : "Password must be at least 8 characters."),
        fieldError("register-confirm", values.confirm === values.password ? "" : "Passwords do not match."),
        fieldError("register-mpin", !values.mpin || /^\d{4}$/.test(values.mpin) ? "" : "MPIN must be exactly 4 digits.")
      ].find(Boolean);
      if (invalid) { invalid.focus(); return; }
      busy($("register-submit"), true, "Creating account…");
      try {
        await auth.register({
          role: state.registerRole, name: $("register-name")?.value.trim(), phone: values.phone, email: values.email,
          password: values.password, mpin: values.mpin,
          latitude: registerLocation?.latitude, longitude: registerLocation?.longitude
        });
        $("register-form").reset();
        registerLocation = null;
        $("register-location-status").textContent = "";
        onSignedIn();
      } catch (error) {
        $("register-error").textContent = error instanceof TypeError ? t("Cannot reach the ASHRAAY server. Check your connection.") : t(error.message);
      } finally {
        busy($("register-submit"), false);
      }
    });

    // ---------- forgot / reset ----------
    $("forgot-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      $("forgot-error").textContent = "";
      const identifier = $("forgot-identifier").value.trim();
      const valid = identifier.includes("@") ? EMAIL_RE.test(identifier) : PHONE_RE.test(identifier.replace(/\D/g, ""));
      const invalid = fieldError("forgot-identifier", valid ? "" : "Enter your registered mobile number or email.");
      if (invalid) { invalid.focus(); return; }
      busy($("forgot-submit"), true, "Sending…");
      try {
        const result = await auth.forgotPassword(identifier);
        state.resetIdentifier = identifier;
        const info = $("reset-info");
        info.textContent = t(result.message);
        if (result.devCode) {
          info.append(document.createElement("br"), `${t("Reset code")}: `);
          const code = document.createElement("b");
          code.textContent = result.devCode;
          info.append(code);
        }
        $("forgot-form").classList.add("hidden");
        $("reset-form").classList.remove("hidden");
        $("reset-code").focus();
      } catch (error) {
        $("forgot-error").textContent = error instanceof TypeError ? t("Cannot reach the ASHRAAY server. Check your connection.") : t(error.message);
      } finally {
        busy($("forgot-submit"), false);
      }
    });

    $("reset-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      $("reset-error").textContent = "";
      const code = $("reset-code").value;
      const newPassword = $("reset-password").value;
      const newMpin = $("reset-mpin").value;
      const invalid = [
        fieldError("reset-code", /^\d{6}$/.test(code) ? "" : "Enter the 6-digit reset code."),
        fieldError("reset-password", newPassword.length >= 8 ? "" : "Password must be at least 8 characters."),
        fieldError("reset-confirm", $("reset-confirm").value === newPassword ? "" : "Passwords do not match."),
        fieldError("reset-mpin", !newMpin || /^\d{4}$/.test(newMpin) ? "" : "MPIN must be exactly 4 digits.")
      ].find(Boolean);
      if (invalid) { invalid.focus(); return; }
      busy($("reset-submit"), true, "Resetting…");
      try {
        const result = await auth.resetPassword({ identifier: state.resetIdentifier, code, newPassword, newMpin });
        $("reset-form").reset();
        showView("signin");
        toast(t(result.message));
      } catch (error) {
        $("reset-error").textContent = error instanceof TypeError ? t("Cannot reach the ASHRAAY server. Check your connection.") : t(error.message);
      } finally {
        busy($("reset-submit"), false);
      }
    });
  }

  global.ashraayLogin = { init };
})(window);
