(() => {
  'use strict';

  const STORAGE_KEY = 'echotag:lang';
  const SUPPORTED = ['en', 'th'];

  const messages = {
    en: {
      'meta.detailsTitle': 'EchoTag — Student sign-in',
      'meta.recorderTitle': 'EchoTag — turn your voice into a QR code',
      'meta.boardTitle': 'EchoTag — Bulletin board',
      'tagline': 'Voice notes, one scan away',
      'nav.language': 'Language',
      'nav.details': 'Data entry',
      'nav.record': 'Voice recording',
      'nav.board': 'Bulletin board',
      'appmode.enter': 'App view',
      'appmode.exit': 'Exit app view',
      'appmode.aria': 'Toggle the app-style layout',
      'blocked.eyebrow': 'Access blocked',
      'blocked.title': 'An administrator blocked this connection.',
      'blocked.defaultReason': 'This IP address cannot use EchoTag right now.',
      'blocked.apiReason': 'An administrator blocked this IP address. Reason: {reason}',
      'blocked.help': 'If you believe this is a mistake, contact the administrator of this EchoTag site.',
      'footer.retentionDays': 'Notes are kept for {days} days, then automatically deleted.',
      'footer.retentionForever': 'Notes are kept until you delete them.',
      'footer.line': 'Audio lives on this server, not inside the QR code.',

      'details.eyebrow': 'Student sign-in · Step 1 of 2',
      'details.title': 'Sign in before<br><span class="gradient-text">you record.</span>',
      'details.lede': 'Enter your school details to sign in. Requests cannot be submitted until you do. After that, you will move to a separate voice recording page.',
      'details.point1': 'Your name, number, and grade stay attached to every note you record',
      'details.point2': 'The administrator can review this information with the audio',
      'details.point3': 'Your sign-in lasts 12 hours on this device',
      'details.step': 'Step 1 of 2 · Sign in',
      'details.warning': '<strong>Use your real name and school details.</strong> Fake, impersonating, or inappropriate names may be blocked from EchoTag and reported to your school.',
      'details.heading': 'Who is recording?',
      'details.sub': 'The administrator can see this information with your recording.',
      'details.fullName': 'Full name',
      'details.fullNamePlaceholder': 'First and last name',
      'details.number': 'Number (เลขที่)',
      'details.numberPlaceholder': 'Select number',
      'details.grade': 'Grade level',
      'details.gradePlaceholder': 'Select grade',
      'details.hint': 'Enter your full name, select your grade and number to sign in.',
      'details.continue': 'Sign in and start recording',
      'details.note': 'Your sign-in lasts 12 hours on this device. Use “Sign out” on the recorder to end it.',
      'details.stateRequired': 'Required',
      'details.stateIncomplete': 'Incomplete',
      'details.stateReady': 'Ready',
      'details.readyHint': 'Signed in. Opening the recorder…',
      'details.signingIn': 'Signing in…',
      'details.loginError': 'Could not sign in. Please try again.',
      'errors.nameRequired': 'Enter your full name.',
      'errors.nameLetters': 'Your name must contain letters.',
      'errors.nameChars': 'Use letters, spaces, hyphens, apostrophes, or periods in your name.',
      'errors.idInvalid': 'Select a number from 1 to 34.',
      'errors.gradeRequired': 'Select your grade level.',

      'recorder.tagline': 'Voice notes, one scan away',
      'recorder.eyebrow': 'No app. No account. Just a voice.',
      'recorder.title': 'Send a voice.<br><span class="gradient-text">Leave a QR.</span>',
      'recorder.lede': 'Record a message, turn it into a scannable code, and let anyone hear it straight from their phone camera — right in the browser.',
      'recorder.point1': 'Works on any phone, no app to install',
      'recorder.point2': 'Plays automatically when the browser allows it',
      'recorder.point3': 'Unlisted link, created fresh for every note',
      'recorder.lanTip': '<strong>Testing on this computer?</strong> Keep your phone on the same Wi-Fi. Your QR will point to your computer\'s network address automatically.',
      'recorder.recordingAs': 'Recording as',
      'recorder.changeDetails': 'Change details',
      'recorder.upTo': 'Up to',
      'recorder.min': 'min',
      'recorder.tapToRecord': 'Tap to record',
      'recorder.speakNaturally': 'Speak naturally. You can preview it before sharing.',
      'recorder.identityUnlocked': 'Identity verified. Recording is unlocked.',
      'recorder.secureNote': 'Recording needs a secure page. Open this site via <strong>localhost</strong> or <strong>HTTPS</strong> to use your microphone.',
      'recorder.live': 'Live',
      'recorder.stopPreview': 'Stop &amp; preview',
      'recorder.cancelRecording': 'Cancel recording',
      'recorder.preview': 'Preview',
      'recorder.titleOptional': 'Title <em>optional</em>',
      'recorder.titlePlaceholder': 'A little hello',
      'recorder.autoplayTitle': 'Play automatically when scanned',
      'recorder.autoplayHint': 'Some browsers still need a tap first.',
      'recorder.createQR': 'Create QR code',
      'recorder.recordAgain': 'Record again',
      'recorder.scanToListen': 'Scan to listen',
      'recorder.voiceNote': 'Voice note',
      'recorder.qrAlt': 'QR code that opens this voice note',
      'recorder.copyLink': 'Copy link',
      'recorder.settingsSummary': 'QR link settings',
      'recorder.settingsBody': 'Use an address your phone can reach — your computer\'s network URL for a same-Wi-Fi test, or your public domain once deployed.',
      'recorder.baseAddress': 'Base address used in the QR code',
      'recorder.apply': 'Apply',
      'recorder.downloadQR': 'Download QR',
      'recorder.openPlayer': 'Open player',
      'recorder.recordAnother': 'Record another',
      'recorder.deleteNote': 'Delete note',
      'recorder.recentNotes': 'Recent notes',
      'recorder.savedInBrowser': 'Saved in this browser',
      'recorder.howTitle': 'Three taps, one voice note',
      'recorder.howSub': 'That is the whole flow',
      'recorder.howStep1Title': 'Record',
      'recorder.howStep1Text': 'Hit the mic and say what a text message cannot. Keep it short or take your time.',
      'recorder.howStep2Title': 'Share',
      'recorder.howStep2Text': 'Your note becomes a clean QR code and a link. Download the code or show it on your screen.',
      'recorder.howStep3Title': 'Scan',
      'recorder.howStep3Text': 'A camera scan opens the player. Audio starts on its own when the browser allows it — otherwise, one tap.',
      'recorder.statusReady': 'Ready',
      'recorder.statusRecording': 'Recording',
      'recorder.statusPreview': 'Preview',
      'recorder.statusResult': 'Ready to scan',
      'recorder.footerLine': 'Audio lives on this server, not inside the QR code.',
      'recorder.signOut': 'Sign out',
      'board.eyebrow': 'Public bulletin board',
      'board.title': 'What’s happening<br><span class="gradient-text">right now.</span>',
      'board.lede': 'Announcements from the administrator. No sign-in is needed to read the board.',
      'board.refresh': 'Refresh',
      'board.loading': 'Loading bulletins…',
      'board.emptyTitle': 'No bulletins yet',
      'board.emptyBody': 'Check back later — new announcements will appear here.',
      'board.error': 'The bulletin board could not be loaded. Try again.',
      'board.postedBy': 'Posted by',
      'board.updated': 'Updated',
    },
    th: {
      'meta.detailsTitle': 'EchoTag — เข้าสู่ระบบนักเรียน',
      'meta.recorderTitle': 'EchoTag — เปลี่ยนเสียงของคุณเป็นคิวอาร์โค้ด',
      'meta.boardTitle': 'EchoTag — กระดานประกาศ',
      'tagline': 'โน้ตเสียง อยู่ใกล้แค่สแกน',
      'nav.language': 'ภาษา',
      'nav.details': 'กรอกข้อมูล',
      'nav.record': 'บันทึกเสียง',
      'nav.board': 'กระดานประกาศ',
      'appmode.enter': 'โหมดแอป',
      'appmode.exit': 'ออกจากโหมดแอป',
      'appmode.aria': 'สลับเป็นรูปแบบแอป',
      'blocked.eyebrow': 'การเข้าถึงถูกระงับ',
      'blocked.title': 'ผู้ดูแลระบบได้บล็อกการเชื่อมต่อนี้',
      'blocked.defaultReason': 'ที่อยู่ IP นี้ไม่สามารถใช้ EchoTag ได้ในขณะนี้',
      'blocked.apiReason': 'ผู้ดูแลระบบบล็อกที่อยู่ IP นี้ เหตุผล: {reason}',
      'blocked.help': 'หากคิดว่าเป็นความผิดพลาด โปรดติดต่อผู้ดูแลระบบของเว็บไซต์ EchoTag นี้',
      'footer.retentionDays': 'เก็บโน้ตไว้ {days} วัน แล้วลบโดยอัตโนมัติ',
      'footer.retentionForever': 'เก็บโน้ตไว้จนกว่าคุณจะลบ',
      'footer.line': 'ไฟล์เสียงอยู่บนเซิร์ฟเวอร์นี้ ไม่ได้อยู่ในคิวอาร์โค้ด',

      'details.eyebrow': 'เข้าสู่ระบบนักเรียน · ขั้นตอนที่ 1 จาก 2',
      'details.title': 'เข้าสู่ระบบ<br><span class="gradient-text">ก่อนบันทึกเสียง</span>',
      'details.lede': 'กรอกข้อมูลโรงเรียนของคุณเพื่อเข้าสู่ระบบ จะส่งคำขอไม่ได้จนกว่าจะเข้าสู่ระบบ จากนั้นระบบจะพาคุณไปยังหน้าบันทึกเสียงแยกต่างหาก',
      'details.point1': 'ชื่อ เลขที่ และระดับชั้นจะแนบไปกับทุกโน้ตที่คุณบันทึก',
      'details.point2': 'ผู้ดูแลระบบสามารถตรวจสอบข้อมูลนี้พร้อมกับไฟล์เสียงได้',
      'details.point3': 'การเข้าสู่ระบบมีอายุ 12 ชั่วโมงบนอุปกรณ์นี้',
      'details.step': 'ขั้นตอนที่ 1 จาก 2 · เข้าสู่ระบบ',
      'details.warning': '<strong>กรุณาใช้ชื่อจริงและข้อมูลโรงเรียนของคุณ</strong> ชื่อปลอม ชื่อที่แอบอ้าง หรือชื่อที่ไม่เหมาะสมอาจถูกบล็อกจาก EchoTag และแจ้งให้โรงเรียนทราบ',
      'details.heading': 'ใครกำลังบันทึกเสียง?',
      'details.sub': 'ผู้ดูแลระบบจะเห็นข้อมูลนี้พร้อมกับไฟล์เสียงของคุณ',
      'details.fullName': 'ชื่อ-นามสกุล',
      'details.fullNamePlaceholder': 'ชื่อและนามสกุล',
      'details.number': 'เลขที่ (Number)',
      'details.numberPlaceholder': 'เลือกเลขที่',
      'details.grade': 'ระดับชั้น',
      'details.gradePlaceholder': 'เลือกระดับชั้น',
      'details.hint': 'กรอกชื่อ-นามสกุล เลือกระดับชั้น และเลขที่เพื่อเข้าสู่ระบบ',
      'details.continue': 'เข้าสู่ระบบและเริ่มบันทึกเสียง',
      'details.note': 'การเข้าสู่ระบบมีอายุ 12 ชั่วโมงบนอุปกรณ์นี้ กด “ออกจากระบบ” ที่หน้าบันทึกเสียงเพื่อสิ้นสุด',
      'details.stateRequired': 'จำเป็น',
      'details.stateIncomplete': 'ยังไม่ครบ',
      'details.stateReady': 'พร้อม',
      'details.readyHint': 'เข้าสู่ระบบแล้ว กำลังเปิดหน้าบันทึกเสียง…',
      'details.signingIn': 'กำลังเข้าสู่ระบบ…',
      'details.loginError': 'ไม่สามารถเข้าสู่ระบบได้ กรุณาลองอีกครั้ง',
      'errors.nameRequired': 'กรอกชื่อ-นามสกุลของคุณ',
      'errors.nameLetters': 'ชื่อของคุณต้องมีตัวอักษร',
      'errors.nameChars': 'ใช้ตัวอักษร เว้นวรรค ยัติภังค์ อะพอสทรอฟี หรือจุดในชื่อของคุณ',
      'errors.idInvalid': 'เลือกเลขที่ตั้งแต่ 1 ถึง 34',
      'errors.gradeRequired': 'เลือกระดับชั้นของคุณ',

      'recorder.tagline': 'โน้ตเสียง อยู่ใกล้แค่สแกน',
      'recorder.eyebrow': 'ไม่ต้องติดตั้งแอป ไม่ต้องมีบัญชี แค่ใช้เสียง',
      'recorder.title': 'ส่งเสียงของคุณ<br><span class="gradient-text">ทิ้งไว้เป็นคิวอาร์</span>',
      'recorder.lede': 'บันทึกข้อความ เปลี่ยนเป็นคิวอาร์โค้ดที่สแกนได้ และให้ใครก็ได้ฟังจากกล้องโทรศัพท์ได้ทันที — ใช้งานในเบราว์เซอร์',
      'recorder.point1': 'ใช้ได้กับทุกโทรศัพท์ ไม่ต้องติดตั้งแอป',
      'recorder.point2': 'เล่นอัตโนมัติเมื่อเบราว์เซอร์อนุญาต',
      'recorder.point3': 'ลิงก์แบบไม่ระบุชื่อ สร้างใหม่สำหรับทุกโน้ต',
      'recorder.lanTip': '<strong>กำลังทดสอบบนคอมพิวเตอร์นี้?</strong> ให้โทรศัพท์อยู่ใน Wi-Fi เดียวกัน คิวอาร์ของคุณจะชี้ไปยังที่อยู่เครือข่ายของคอมพิวเตอร์โดยอัตโนมัติ',
      'recorder.recordingAs': 'บันทึกในชื่อ',
      'recorder.changeDetails': 'เปลี่ยนข้อมูล',
      'recorder.upTo': 'สูงสุด',
      'recorder.min': 'นาที',
      'recorder.tapToRecord': 'แตะเพื่อบันทึกเสียง',
      'recorder.speakNaturally': 'พูดตามธรรมชาติ คุณสามารถฟังตัวอย่างก่อนแชร์ได้',
      'recorder.identityUnlocked': 'ยืนยันตัวตนแล้ว ปลดล็อกการบันทึกเสียง',
      'recorder.secureNote': 'การบันทึกเสียงต้องใช้หน้าปลอดภัย เปิดเว็บนี้ผ่าน <strong>localhost</strong> หรือ <strong>HTTPS</strong> เพื่อใช้ไมโครโฟน',
      'recorder.live': 'กำลังบันทึก',
      'recorder.stopPreview': 'หยุดและฟังตัวอย่าง',
      'recorder.cancelRecording': 'ยกเลิกการบันทึก',
      'recorder.preview': 'ตัวอย่าง',
      'recorder.titleOptional': 'ชื่อโน้ต <em>ไม่บังคับ</em>',
      'recorder.titlePlaceholder': 'ข้อความทักทายสั้น ๆ',
      'recorder.autoplayTitle': 'เล่นอัตโนมัติเมื่อสแกน',
      'recorder.autoplayHint': 'บางเบราว์เซอร์ยังต้องแตะก่อนเล่น',
      'recorder.createQR': 'สร้างคิวอาร์โค้ด',
      'recorder.recordAgain': 'บันทึกใหม่',
      'recorder.scanToListen': 'สแกนเพื่อฟัง',
      'recorder.voiceNote': 'โน้ตเสียง',
      'recorder.qrAlt': 'คิวอาร์โค้ดสำหรับเปิดโน้ตเสียงนี้',
      'recorder.copyLink': 'คัดลอกลิงก์',
      'recorder.settingsSummary': 'ตั้งค่าลิงก์คิวอาร์',
      'recorder.settingsBody': 'ใช้ที่อยู่ที่โทรศัพท์ของคุณเข้าถึงได้ — ที่อยู่เครือข่ายของคอมพิวเตอร์สำหรับทดสอบใน Wi-Fi เดียวกัน หรือโดเมนสาธารณะหลังติดตั้ง',
      'recorder.baseAddress': 'ที่อยู่หลักที่ใช้ในคิวอาร์โค้ด',
      'recorder.apply': 'ใช้',
      'recorder.downloadQR': 'ดาวน์โหลดคิวอาร์',
      'recorder.openPlayer': 'เปิดหน้าผู้เล่น',
      'recorder.recordAnother': 'บันทึกอีกอัน',
      'recorder.deleteNote': 'ลบโน้ต',
      'recorder.recentNotes': 'โน้ตล่าสุด',
      'recorder.savedInBrowser': 'บันทึกไว้ในเบราว์เซอร์นี้',
      'recorder.howTitle': 'สามขั้นตอน หนึ่งโน้ตเสียง',
      'recorder.howSub': 'มีเท่านี้เอง',
      'recorder.howStep1Title': 'บันทึก',
      'recorder.howStep1Text': 'กดไมค์แล้วพูดในสิ่งที่ข้อความธรรมดาเล่าไม่ได้ จะสั้นหรือยาวตามใจคุณ',
      'recorder.howStep2Title': 'แชร์',
      'recorder.howStep2Text': 'โน้ตของคุณจะกลายเป็นคิวอาร์โค้ดและลิงก์ที่เรียบง่าย ดาวน์โหลดหรือแสดงบนหน้าจอได้เลย',
      'recorder.howStep3Title': 'สแกน',
      'recorder.howStep3Text': 'การสแกนด้วยกล้องจะเปิดหน้าผู้เล่น เสียงจะเล่นอัตโนมัติเมื่อเบราว์เซอร์อนุญาต ไม่เช่นนั้นเพียงแตะครั้งเดียว',
      'recorder.statusReady': 'พร้อม',
      'recorder.statusRecording': 'กำลังบันทึก',
      'recorder.statusPreview': 'ตัวอย่าง',
      'recorder.statusResult': 'พร้อมสแกน',
      'recorder.footerLine': 'ไฟล์เสียงอยู่บนเซิร์ฟเวอร์นี้ ไม่ได้อยู่ในคิวอาร์โค้ด',
      'recorder.signOut': 'ออกจากระบบ',
      'board.eyebrow': 'กระดานประกาศสาธารณะ',
      'board.title': 'เรื่องที่กำลังเกิดขึ้น<br><span class="gradient-text">ตอนนี้</span>',
      'board.lede': 'ประกาศจากผู้ดูแลระบบ ทุกคนสามารถอ่านกระดานได้โดยไม่ต้องเข้าสู่ระบบ',
      'board.refresh': 'รีเฟรช',
      'board.loading': 'กำลังโหลดประกาศ…',
      'board.emptyTitle': 'ยังไม่มีประกาศ',
      'board.emptyBody': 'กลับมาดูใหม่ภายหลัง — ประกาศใหม่จะแสดงที่นี่',
      'board.error': 'ไม่สามารถโหลดกระดานประกาศได้ กรุณาลองอีกครั้ง',
      'board.postedBy': 'ประกาศโดย',
      'board.updated': 'อัปเดต',
    },
  };

  let language = 'en';

  function normalizeLanguage(value) {
    return SUPPORTED.includes(value) ? value : 'en';
  }

  function loadLanguage() {
    try {
      return normalizeLanguage(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      return 'en';
    }
  }

  function interpolate(text, vars) {
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
    ));
  }

  function t(key, vars) {
    const value = messages[language][key] ?? messages.en[key] ?? key;
    return interpolate(value, vars);
  }

  function apply(root = document) {
    document.documentElement.lang = language;
    const page = document.body && document.body.dataset.page;
    const titleKey = page === 'details'
      ? 'meta.detailsTitle'
      : page === 'board'
        ? 'meta.boardTitle'
        : 'meta.recorderTitle';
    document.title = t(titleKey);

    root.querySelectorAll('[data-i18n]').forEach((element) => {
      element.innerHTML = t(element.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
      element.setAttribute('placeholder', t(element.getAttribute('data-i18n-placeholder')));
    });
    root.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
      element.setAttribute('aria-label', t(element.getAttribute('data-i18n-aria-label')));
    });
    root.querySelectorAll('[data-language-select]').forEach((select) => {
      select.value = language;
    });
  }

  function setLanguage(next) {
    language = normalizeLanguage(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Private browsing may disable storage; the page still switches language.
    }
    apply();
    document.dispatchEvent(new CustomEvent('echotag:language', { detail: { language } }));
  }

  function bindLanguageMenus() {
    document.querySelectorAll('[data-language-select]').forEach((select) => {
      select.value = language;
      select.addEventListener('change', () => setLanguage(select.value));
    });
  }

  language = loadLanguage();
  window.EchoTagI18n = {
    t,
    apply,
    setLanguage,
    get language() {
      return language;
    },
  };

  apply();
  bindLanguageMenus();
})();
