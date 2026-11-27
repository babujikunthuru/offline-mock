# Operating System
An operating system is system software that manages computer hardware and provides common services to applications. It coordinates processes, memory, files, devices, and security so programs can share a machine safely. Users interact with it through graphical or command-line interfaces, while applications use operating-system services through system calls. For example, when a text editor saves a document, the operating system manages the request to write data to storage.

# Processes and Threads
A process is a running program with its own address space and operating-system resources. A thread is an execution path within a process, and threads in the same process can share memory. The scheduler allocates processor time among runnable work. This model supports multitasking but requires care when shared data changes concurrently. For example, a browser may use separate processes for tabs and multiple threads inside a process to handle work efficiently.

# CPU Scheduling
CPU scheduling is the method an operating system uses to choose which ready process or thread runs next. Scheduling algorithms balance goals such as responsiveness, throughput, fairness, and waiting time. Round robin gives each task a time slice, while priority scheduling prefers more important work. For example, an interactive application may need quick responses even when background jobs are running. Poor scheduling can leave a low-priority process waiting too long.

# Memory Management
Memory management is the operating system's work of tracking and allocating main memory to processes. Virtual memory gives each process an address space and maps virtual addresses to physical memory. Paging moves fixed-size blocks, called pages, between memory and storage when needed. For example, virtual memory helps isolate applications and allows a computer to run programs whose combined memory needs exceed available physical RAM, though excessive paging slows the system.

# Files and Storage
A file system is the operating system component that organizes stored data as named files and directories. It tracks metadata such as file size, location, and access permissions. Storage devices provide persistent data, unlike volatile main memory. For example, a directory can group related project files, and permissions can allow a student to read a shared document without modifying it. Backups protect against accidental deletion or device failure.

# Deadlocks and Security
A deadlock is a condition in which processes wait indefinitely for resources held by one another. Prevention, avoidance, detection, or recovery can address deadlocks. Operating-system security controls access using identities, permissions, isolation, and updates. For example, a process that holds a printer while waiting for a file lock can contribute to deadlock, while least-privilege permissions reduce the damage if an application is compromised.
