import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Translations for the member-facing dose-card view. The admin Dashboard is
// English-only for now; only Rajan-style member screens need localisation.
const resources = {
  en: {
    translation: {
      greeting: {
        morning:   'Good morning',
        afternoon: 'Good afternoon',
        evening:   'Good evening',
      },
      member: {
        markAsTaken:   'Mark as Taken',
        skip:          'Skip',
        takeLater:     "I'll take it later",
        allDoneTitle:  'All done for today!',
        allDoneBody:   "{{name}}, you've taken all your medicines today.",
        nextTomorrow:  'Next dose around {{time}} tomorrow',
        missedTitle:   'Missed earlier?',
        markLateTaken: 'Mark as Late Taken',
        takeBefore:    'Take before food',
        takeAfter:     'Take after food',
        takeWith:      'Take with food',
      },
    },
  },
  hi: {
    translation: {
      greeting: {
        morning:   'सुप्रभात',
        afternoon: 'नमस्कार',
        evening:   'शुभ संध्या',
      },
      member: {
        markAsTaken:   'ले लिया',
        skip:          'छोड़ें',
        takeLater:     'बाद में लूंगा',
        allDoneTitle:  'आज के लिए हो गया!',
        allDoneBody:   '{{name}}, आपने आज की सभी दवाएँ ले ली हैं।',
        nextTomorrow:  'अगली खुराक कल लगभग {{time}} पर',
        missedTitle:   'क्या आप कोई खुराक भूल गए?',
        markLateTaken: 'देर से ली गई के रूप में चिह्नित करें',
        takeBefore:    'खाने से पहले लें',
        takeAfter:     'खाने के बाद लें',
        takeWith:      'खाने के साथ लें',
      },
    },
  },
  kn: {
    translation: {
      greeting: {
        morning:   'ಶುಭೋದಯ',
        afternoon: 'ಶುಭ ಮಧ್ಯಾಹ್ನ',
        evening:   'ಶುಭ ಸಂಜೆ',
      },
      member: {
        markAsTaken:   'ತೆಗೆದುಕೊಂಡೆ',
        skip:          'ಬಿಡು',
        takeLater:     'ನಂತರ ತೆಗೆದುಕೊಳ್ಳುತ್ತೇನೆ',
        allDoneTitle:  'ಇಂದಿಗೆ ಎಲ್ಲಾ ಮುಗಿದಿದೆ!',
        allDoneBody:   '{{name}}, ನೀವು ಇಂದಿನ ಎಲ್ಲಾ ಔಷಧಗಳನ್ನು ತೆಗೆದುಕೊಂಡಿದ್ದೀರಿ.',
        nextTomorrow:  'ಮುಂದಿನ ಡೋಸ್ ನಾಳೆ ಸುಮಾರು {{time}}',
        missedTitle:   'ಬೆಳಿಗ್ಗೆ ತಪ್ಪಿಸಿಕೊಂಡಿರಾ?',
        markLateTaken: 'ತಡವಾಗಿ ತೆಗೆದುಕೊಂಡಂತೆ ಗುರುತಿಸಿ',
        takeBefore:    'ಆಹಾರಕ್ಕೂ ಮೊದಲು ತೆಗೆದುಕೊಳ್ಳಿ',
        takeAfter:     'ಆಹಾರದ ನಂತರ ತೆಗೆದುಕೊಳ್ಳಿ',
        takeWith:      'ಆಹಾರದ ಜೊತೆಗೆ ತೆಗೆದುಕೊಳ್ಳಿ',
      },
    },
  },
}

i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export default i18n
