# Database and DBMS
A database is an organized collection of data, and a database management system is software used to define, store, query, and protect that data. A DBMS coordinates access so applications do not need to manage raw files directly. It can enforce rules, support concurrent users, and recover after failures. For example, a college system can use a database to store student, course, and enrollment records and answer questions about current registrations.

# Relational Model
The relational model represents data in tables made of rows and columns. A row is a record, and a column describes one attribute shared by records in a table. Relations can connect through values that represent identifiers. This structure provides a consistent way to describe and query related information. For example, a Students table can store each learner once, while an Enrollments table records which learners take which courses during a term.

# Keys and Constraints
A key is an attribute or group of attributes used to identify or relate records. A primary key uniquely identifies each row, and a foreign key refers to a key in another table. Constraints are rules that prevent invalid data from being stored. For example, a student identifier can be a primary key, while an enrollment's student identifier can be a foreign key. A not-null constraint can ensure every enrollment has a valid student.

# SQL and Joins
SQL is a language for defining relational structures and querying or changing their data. SELECT retrieves rows, WHERE filters them, and JOIN combines related tables using a matching condition. Aggregation functions summarize groups of rows. For example, a query can join Students with Enrollments and count how many courses each learner takes. Clear conditions matter because a missing join condition can produce a large, misleading result.

# Normalization
Normalization is the process of structuring relational tables to reduce repeated facts and update anomalies. It separates information into related tables and connects them with keys. A well-designed schema stores each fact in a suitable place, so changing a fact does not require editing many duplicate rows. For example, storing an instructor's office once in an Instructors table avoids inconsistent copies in every course record.

# Transactions and Indexes
A transaction is a group of database operations treated as one logical unit. ACID properties describe atomicity, consistency, isolation, and durability. An index is an auxiliary structure that can speed up lookups but takes storage and can slow writes. For example, transferring funds should debit one account and credit another in a single transaction, while an index on a frequently searched email column can make account lookup faster.
