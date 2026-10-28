"""PostgreSQL persistence for books and per-reader reading progress."""
import json
import uuid
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def _connect():
    from backend.config import settings

    if not settings.DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not configured. Set it in your .env file.")
    return psycopg.connect(settings.DATABASE_URL, row_factory=dict_row)


def initialize_database() -> None:
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS profiles (
                user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                display_name TEXT NOT NULL DEFAULT '',
                country_or_region TEXT NOT NULL DEFAULT '',
                education_board TEXT NOT NULL DEFAULT '',
                grade_or_standard TEXT NOT NULL DEFAULT '',
                academic_year TEXT NOT NULL DEFAULT '',
                reading_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS books (
                id UUID PRIMARY KEY,
                reader_id UUID NOT NULL,
                title TEXT NOT NULL,
                paragraphs_json JSONB NOT NULL,
                page_count INTEGER NOT NULL DEFAULT 1 CHECK(page_count >= 1),
                last_opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(reader_id, id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS reading_progress (
                reader_id UUID NOT NULL,
                book_id UUID NOT NULL,
                page_pointer INTEGER NOT NULL DEFAULT 1 CHECK(page_pointer >= 1),
                paragraph_index INTEGER NOT NULL DEFAULT 0 CHECK(paragraph_index >= 0),
                sentence_index INTEGER NOT NULL DEFAULT 0 CHECK(sentence_index >= 0),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(reader_id, book_id),
                FOREIGN KEY(reader_id, book_id) REFERENCES books(reader_id, id) ON DELETE CASCADE
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS ix_books_reader_created ON books(reader_id, created_at DESC)")
        conn.execute("ALTER TABLE books ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ")
        # Preserve existing prototype tables while tying future rows to real accounts.
        conn.execute("""
            DO $$ BEGIN
                ALTER TABLE books ADD CONSTRAINT fk_books_reader_user
                    FOREIGN KEY (reader_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        """)
        conn.execute("""
            DO $$ BEGIN
                ALTER TABLE reading_progress ADD CONSTRAINT fk_progress_reader_user
                    FOREIGN KEY (reader_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        """)


def create_user(email: str, password_hash: str, display_name: str) -> dict[str, Any]:
    user_id = str(uuid.uuid4())
    with _connect() as conn:
        row = conn.execute(
            "INSERT INTO users(id, email, password_hash) VALUES (%s, %s, %s) "
            "RETURNING id, email, created_at", (user_id, email, password_hash)
        ).fetchone()
        conn.execute(
            "INSERT INTO profiles(user_id, display_name) VALUES (%s, %s)",
            (user_id, display_name),
        )
    return {**row, "id": str(row["id"])}


def get_user_by_email(email: str) -> dict[str, Any] | None:
    with _connect() as conn:
        return conn.execute(
            "SELECT id, email, password_hash FROM users WHERE email=%s", (email,)
        ).fetchone()


def get_user_profile(user_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        return conn.execute(
            "SELECT u.id, u.email, p.display_name, p.country_or_region, p.education_board, "
            "p.grade_or_standard, p.academic_year, p.reading_preferences "
            "FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=%s", (user_id,)
        ).fetchone()


def update_user_profile(user_id: str, values: dict[str, Any]) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "UPDATE profiles SET display_name=%s, country_or_region=%s, education_board=%s, "
            "grade_or_standard=%s, academic_year=%s, updated_at=CURRENT_TIMESTAMP "
            "WHERE user_id=%s RETURNING user_id",
            (values["display_name"], values["country_or_region"], values["education_board"],
             values["grade_or_standard"], values["academic_year"], user_id),
        ).fetchone()
    return get_user_profile(user_id) if row else None


def save_book(reader_id: str, title: str, paragraphs: list[dict[str, Any]], page_count: int) -> str:
    book_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO books(id, reader_id, title, paragraphs_json, page_count, last_opened_at) "
            "VALUES (%s, %s, %s, %s, %s, CURRENT_TIMESTAMP)",
            (book_id, reader_id, title, Jsonb(paragraphs), max(1, page_count)),
        )
        conn.execute(
            "INSERT INTO reading_progress(reader_id, book_id) VALUES (%s, %s)", (reader_id, book_id)
        )
    return book_id


def get_book(reader_id: str, book_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT b.*, p.page_pointer, p.paragraph_index, p.sentence_index "
            "FROM books b LEFT JOIN reading_progress p ON p.reader_id=b.reader_id AND p.book_id=b.id "
            "WHERE b.reader_id=%s AND b.id=%s", (reader_id, book_id)
        ).fetchone()
    if not row:
        return None
    paragraphs = row["paragraphs_json"]
    if isinstance(paragraphs, str):
        paragraphs = json.loads(paragraphs)
    return {**row, "paragraphs": paragraphs}


def get_last_book(reader_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT id FROM books WHERE reader_id=%s "
            "ORDER BY last_opened_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1",
            (reader_id,),
        ).fetchone()
    return get_book(reader_id, str(row["id"])) if row else None


def mark_book_opened(reader_id: str, book_id: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE books SET last_opened_at=CURRENT_TIMESTAMP WHERE reader_id=%s AND id=%s",
            (reader_id, book_id),
        )


def list_books(reader_id: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT b.id, b.title, b.page_count, b.created_at, p.page_pointer, "
            "p.paragraph_index, p.sentence_index, p.updated_at "
            "FROM books b JOIN reading_progress p ON p.reader_id=b.reader_id AND p.book_id=b.id "
            "WHERE b.reader_id=%s ORDER BY p.updated_at DESC, b.created_at DESC",
            (reader_id,),
        ).fetchall()
    return [{**row, "id": str(row["id"])} for row in rows]


def delete_book(reader_id: str, book_id: str) -> bool:
    """Delete a book owned by this reader and its saved reading progress."""
    with _connect() as conn:
        result = conn.execute(
            "DELETE FROM books WHERE reader_id=%s AND id=%s",
            (reader_id, book_id),
        )
        return result.rowcount == 1


def save_progress(reader_id: str, book_id: str, page_pointer: int, paragraph_index: int, sentence_index: int) -> bool:
    with _connect() as conn:
        result = conn.execute(
            "UPDATE reading_progress SET page_pointer=%s, paragraph_index=%s, sentence_index=%s, "
            "updated_at=CURRENT_TIMESTAMP WHERE reader_id=%s AND book_id=%s",
            (page_pointer, paragraph_index, sentence_index, reader_id, book_id),
        )
        return result.rowcount == 1


