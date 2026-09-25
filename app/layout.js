import './globals.css'

export const metadata = { title: 'ReadAny', description: 'Local document reader with text-to-speech' }

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  )
}
