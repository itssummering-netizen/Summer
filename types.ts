export interface Note {
  id: string;
  title: string;
  content: string;
  updatedAt: number;
  folder?: string; // Links to Folder.name
  deletedAt?: number; // If present, the note is in the trash
}

export interface Folder {
  id: string;
  name: string;
  color: string; // Hex code or tailwind class
  icon: string; // Icon name key
  deletedAt?: number; // If present, the folder is in the trash
}

export enum AIAction {
  SUMMARIZE = 'summarize',
  FIX_GRAMMAR = 'fix_grammar',
  CONTINUE_WRITING = 'continue_writing'
}

export interface DailyTask {
  id: string;
  text: string;
  completed: boolean;
  column: 'red' | 'yellow' | 'green';
  createdAt: number;
}

export interface DontDoTask {
  id: string;
  text: string;
  createdAt: number;
}

export interface ExpectedSchedule {
  id: string;
  text: string;
  date: string; // YYYY-MM-DD
  createdAt: number;
}
