import React, { useState, useEffect, useRef } from 'react';
import { Note, AIAction, Folder as FolderType } from '../types';
import { 
  Wand2, Loader2, ArrowLeft, 
  Bold, Italic, List, CheckSquare, Underline,
  ChevronDown, Folder
} from 'lucide-react';
import { processTextWithAI } from '../services/geminiService';

interface EditorProps {
  note: Note;
  folders: FolderType[];
  onUpdateNote: (id: string, updates: Partial<Note>) => void;
  onBack: () => void; // For mobile
}

export const Editor: React.FC<EditorProps> = ({ note, folders, onUpdateNote, onBack }) => {
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [showAiMenu, setShowAiMenu] = useState(false);
  const [showFolderMenu, setShowFolderMenu] = useState(false);
  
  const aiMenuRef = useRef<HTMLDivElement>(null);
  const folderMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (aiMenuRef.current && !aiMenuRef.current.contains(event.target as Node)) {
        setShowAiMenu(false);
      }
      if (folderMenuRef.current && !folderMenuRef.current.contains(event.target as Node)) {
        setShowFolderMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdateNote(note.id, { title: e.target.value, updatedAt: Date.now() });
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onUpdateNote(note.id, { content: e.target.value, updatedAt: Date.now() });
  };
  
  const handleFolderChange = (folderName: string) => {
      onUpdateNote(note.id, { folder: folderName, updatedAt: Date.now() });
      setShowFolderMenu(false);
  };

  // Improved markdown insertion
  const insertFormat = (prefix: string, suffix: string = '', isBlock: boolean = false) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = note.content;
    const selection = text.substring(start, end);

    let newText = "";
    let newCursorPos = 0;

    if (isBlock) {
      // Logic for block elements (Lists, Headings)
      // Check if we are at the start of a line
      const beforeCursor = text.substring(0, start);
      const lastNewLine = beforeCursor.lastIndexOf('\n');
      const isStartOfLine = lastNewLine === -1 || lastNewLine === start - 1;
      
      const insertPrefix = isStartOfLine ? prefix : `\n${prefix}`;
      
      newText = text.substring(0, start) + insertPrefix + selection + suffix + text.substring(end);
      newCursorPos = start + insertPrefix.length + selection.length + suffix.length;
    } else {
      // Logic for inline elements (Bold, Italic)
      newText = text.substring(0, start) + prefix + selection + suffix + text.substring(end);
      newCursorPos = end + prefix.length + suffix.length;
      
      // If simply clicking button with no selection, put cursor inside tags
      if (start === end) {
          newCursorPos = start + prefix.length;
      }
    }
    
    onUpdateNote(note.id, { content: newText, updatedAt: Date.now() });
    
    // Restore focus and set cursor
    setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const handleAIAction = async (action: AIAction) => {
    setShowAiMenu(false);
    setIsAiLoading(true);

    try {
      const result = await processTextWithAI(note.content, action);
      
      if (action === AIAction.CONTINUE_WRITING) {
        // Append
        const newContent = note.content + (note.content.endsWith(' ') ? '' : ' ') + result;
        onUpdateNote(note.id, { content: newContent, updatedAt: Date.now() });
      } else {
        if (action === AIAction.SUMMARIZE) {
           const newContent = note.content + "\n\n--- Tóm tắt bởi AI ---\n" + result;
           onUpdateNote(note.id, { content: newContent, updatedAt: Date.now() });
        } else {
           // Fix Grammar - replace content
           onUpdateNote(note.id, { content: result, updatedAt: Date.now() });
        }
      }
    } catch (error) {
      alert("Có lỗi xảy ra khi gọi AI. Vui lòng kiểm tra API Key.");
    } finally {
      setIsAiLoading(false);
    }
  };

  const formattedDate = new Intl.DateTimeFormat('vi-VN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(note.updatedAt));

  return (
    <div className="flex flex-col h-full bg-white relative">
      {/* Mobile Back Button */}
      <div className="md:hidden p-4 border-b border-gray-100 flex items-center text-yellow-600 cursor-pointer bg-white z-10" onClick={onBack}>
        <ArrowLeft size={20} className="mr-1" />
        <span className="font-medium">Danh sách</span>
      </div>

      <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full pt-6 px-6 md:px-14 pb-24 h-full overflow-hidden">
        
        {/* Header Metadata (Date & Folder Selector) */}
        <div className="flex flex-col items-center justify-center mb-6 gap-2">
            <div className="text-gray-400 text-xs font-semibold opacity-60">
                {formattedDate}
            </div>
            
            {/* Folder Selector */}
            <div className="relative" ref={folderMenuRef}>
                <button 
                    onClick={() => setShowFolderMenu(!showFolderMenu)}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-gray-100 hover:bg-gray-200 text-xs font-medium text-gray-600 transition-colors"
                >
                    <Folder size={12} />
                    <span>{note.folder || 'Chung'}</span>
                    <ChevronDown size={12} />
                </button>
                
                {showFolderMenu && (
                    <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 w-48 bg-white rounded-xl shadow-xl border border-gray-100 py-1 z-30 animate-in fade-in zoom-in-95 duration-100">
                        <div className="px-3 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-50 mb-1">
                            Chọn thư mục
                        </div>
                        <button
                            onClick={() => handleFolderChange('Chung')}
                            className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2 ${(!note.folder || note.folder === 'Chung') ? 'text-blue-600 font-medium' : 'text-gray-700'}`}
                        >
                            <div className="w-2 h-2 rounded-full bg-gray-300"></div>
                            Chung
                        </button>
                        {folders.map(f => (
                            <button
                                key={f.id}
                                onClick={() => handleFolderChange(f.name)}
                                className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2 ${note.folder === f.name ? 'text-blue-600 font-medium' : 'text-gray-700'}`}
                            >
                                <div className={`w-2 h-2 rounded-full ${f.color.replace('bg-', 'bg-')}`}></div>
                                {f.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>

        {/* Title Input */}
        <input
          type="text"
          value={note.title}
          onChange={handleTitleChange}
          placeholder="Tiêu đề"
          className="text-3xl md:text-4xl font-bold text-gray-900 placeholder-gray-300 border-none outline-none bg-transparent w-full mb-6 tracking-tight"
        />

        {/* Content Textarea */}
        <textarea
          ref={textareaRef}
          value={note.content}
          onChange={handleContentChange}
          placeholder="Bắt đầu viết..."
          className="flex-1 resize-none border-none outline-none text-lg text-gray-800 leading-relaxed placeholder-gray-300 w-full bg-transparent no-scrollbar"
        />
      </div>

      {/* Floating Bottom Toolbar Container */}
      <div className="absolute bottom-8 left-0 right-0 px-4 flex justify-center items-center pointer-events-none z-20">
          
          {/* Unified Toolbar Pill - Increased size */}
          <div className="pointer-events-auto flex items-center gap-6 bg-[#F8F8F8] px-8 py-3 rounded-full border border-gray-200/60 mx-auto backdrop-blur-xl">
              <button 
                  onClick={() => insertFormat('**', '**')} 
                  className="text-gray-500 hover:text-gray-900 transition-colors focus:outline-none p-1.5" 
                  title="In đậm"
              >
                  <Bold strokeWidth={2.5} size={20} />
              </button>
              <button 
                  onClick={() => insertFormat('*', '*')} 
                  className="text-gray-500 hover:text-gray-900 transition-colors focus:outline-none p-1.5" 
                  title="In nghiêng"
              >
                  <Italic strokeWidth={2.5} size={20} />
              </button>
              <button 
                  onClick={() => insertFormat('__', '__')} 
                  className="text-gray-500 hover:text-gray-900 transition-colors focus:outline-none p-1.5" 
                  title="Gạch chân"
              >
                  <Underline strokeWidth={2.5} size={20} />
              </button>
              
              <div className="w-px h-5 bg-gray-300/60 mx-1"></div>
              
              <button 
                  onClick={() => insertFormat('- ', '', true)} 
                  className="text-gray-500 hover:text-gray-900 transition-colors focus:outline-none p-1.5" 
                  title="Danh sách"
              >
                  <List strokeWidth={2.5} size={20} />
              </button>
              <button 
                  onClick={() => insertFormat('- [ ] ', '', true)} 
                  className="text-gray-500 hover:text-gray-900 transition-colors focus:outline-none p-1.5" 
                  title="Checklist"
              >
                  <CheckSquare strokeWidth={2.5} size={20} />
              </button>

              <div className="w-px h-5 bg-gray-300/60 mx-1"></div>

              {/* AI Button - Integrated & Sized up */}
              <div className="relative" ref={aiMenuRef}>
                  <div className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-4 flex flex-col gap-2 transition-all duration-200 w-max ${showAiMenu ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}`}>
                      <button
                          onClick={() => handleAIAction(AIAction.SUMMARIZE)}
                          className="flex items-center gap-3 px-5 py-3 bg-white text-gray-700 rounded-2xl border border-gray-200/60 hover:bg-gray-50 transition-transform active:scale-95 whitespace-nowrap shadow-sm text-[15px]"
                      >
                          <span className="font-medium">Tóm tắt</span>
                          <div className="w-5 h-5 rounded-full bg-purple-100 text-purple-600 flex items-center justify-center text-[10px] font-bold">AI</div>
                      </button>
                      <button
                          onClick={() => handleAIAction(AIAction.FIX_GRAMMAR)}
                          className="flex items-center gap-3 px-5 py-3 bg-white text-gray-700 rounded-2xl border border-gray-200/60 hover:bg-gray-50 transition-transform active:scale-95 whitespace-nowrap shadow-sm text-[15px]"
                      >
                          <span className="font-medium">Sửa chính tả</span>
                          <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-[10px] font-bold">AI</div>
                      </button>
                      <button
                          onClick={() => handleAIAction(AIAction.CONTINUE_WRITING)}
                          className="flex items-center gap-3 px-5 py-3 bg-white text-gray-700 rounded-2xl border border-gray-200/60 hover:bg-gray-50 transition-transform active:scale-95 whitespace-nowrap shadow-sm text-[15px]"
                      >
                          <span className="font-medium">Viết tiếp</span>
                          <div className="w-5 h-5 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-[10px] font-bold">AI</div>
                      </button>
                  </div>

                  <button
                    onClick={() => setShowAiMenu(!showAiMenu)}
                    disabled={isAiLoading}
                    className={`flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200 border ${
                        showAiMenu ? 'bg-gray-800 text-white border-gray-800' : 'bg-yellow-400 hover:bg-yellow-500 text-yellow-950 border-yellow-500/10'
                    }`}
                  >
                    {isAiLoading ? (
                        <Loader2 className="animate-spin" size={18} />
                    ) : (
                        <Wand2 size={18} strokeWidth={2.5} />
                    )}
                  </button>
              </div>
          </div>
      </div>
    </div>
  );
};